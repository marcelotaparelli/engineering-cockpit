import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { assertNoSymlinks } from "./paths.ts";
import { SafeError, safeCode, type Snapshot } from "./model.ts";
import type { EventHub } from "./event-hub.ts";
import type {
  ApprovalSummary, ExecutionTarget, HistoryPage, ProtocolIdentity, ProviderAdapter, ProviderApprovalRef,
  ProviderConnection, ProviderErrorClass, ProviderEvent, ProviderSessionSummary, RunStatus,
} from "./provider.ts";
import type { ApprovalRecord, RunRecord, RuntimeStore, SessionRecord } from "./runtime-store.ts";

export interface ExecutionLog {
  event: "run.dispatched" | "run.dispatch_failed" | "run.finished" | "run.transport_lost" | "approval.decided" | "provider.connected" | "provider.connect_failed" | "run.reconciled";
  run_id?: string;
  outcome?: string;
  error_code?: string;
  duration_ms?: number;
}

export interface ExecutionOptions {
  store: RuntimeStore;
  adapter: ProviderAdapter;
  hub: EventHub;
  refresh: () => Promise<Snapshot>;
  now?: () => Date;
  approvalTtlMs?: number;
  /** Per-install secret for HMAC digests of prompts/actions (kept outside the database). */
  digestKey?: Uint8Array;
  log?: (entry: ExecutionLog) => void;
}

export interface ApprovalView extends ApprovalRecord {
  projectId: string;
  sessionId: string;
  vmName: string;
  summary: (ApprovalSummary & { files: string[] }) | null;
}

export interface ThreadView { id: string; status: ProviderSessionSummary["status"]; updatedAt: string | null; sessionId: string | null }

interface Live {
  vmName: string;
  connection: ProviderConnection;
  identity: ProtocolIdentity;
  loaded: Set<string>;
  closed: boolean;
  files: Map<string, string[]>;
}
interface ActiveRun { runId: string; session: SessionRecord; live: Live; providerRunId: string | null; buffer: ProviderEvent[]; errorClass?: ProviderErrorClass }

const ERROR_REASON: Readonly<Record<ProviderErrorClass, string>> = Object.freeze({
  usage_limit: "provider_usage_limit", auth: "provider_auth_failed", transport: "provider_transport_error", context_window: "provider_context_window",
  bad_request: "provider_bad_request", overloaded: "provider_overloaded", sandbox: "provider_sandbox_error", provider_internal: "provider_internal_error",
});
interface PendingApproval { approvalId: string; runId: string; live: Live; ref: ProviderApprovalRef; summary: ApprovalSummary & { files: string[] } }

const MAX_PROMPT_CHARS = 64 * 1024;
const UNCERTAIN: readonly RunStatus[] = ["dispatching", "running", "awaiting_approval"];
function failureReason(errorClass: ProviderErrorClass | null | undefined): string { return errorClass ? ERROR_REASON[errorClass] : "provider_turn_failed"; }
const TERMINAL: readonly RunStatus[] = ["completed", "failed", "interrupted"];

/** Load or create a 32-byte secret file (0600, no symlinks). */
export function loadDigestKey(path: string): Uint8Array {
  assertNoSymlinks(path);
  try { closeSync(openSync(path, "wx", 0o600)); writeFileSync(path, randomBytes(32), { mode: 0o600 }); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size !== 32) throw new SafeError("unsafe_digest_key");
  return readFileSync(path);
}

/**
 * Owns provider connections (one per VM) and turns browser intents into exactly-once provider operations.
 * Invariants: a prompt is sent at most once per run; anything that may have been sent but is not confirmed
 * becomes `unknown` and is never replayed; approvals are answered only by an explicit human decision.
 */
export class ExecutionService {
  readonly #store: RuntimeStore;
  readonly #adapter: ProviderAdapter;
  readonly #hub: EventHub;
  readonly #refresh: () => Promise<Snapshot>;
  readonly #now: () => Date;
  readonly #approvalTtlMs: number;
  readonly #digestKey: Uint8Array;
  readonly #log: (entry: ExecutionLog) => void;
  readonly #connections = new Map<string, Promise<Live>>();
  readonly #lives = new Map<string, Live>();
  readonly #active = new Map<string, ActiveRun>(); // key: vm \0 providerSessionId
  readonly #approvals = new Map<string, PendingApproval>();
  #closed = false;

  constructor(options: ExecutionOptions) {
    this.#store = options.store;
    this.#adapter = options.adapter;
    this.#hub = options.hub;
    this.#refresh = options.refresh;
    this.#now = options.now ?? (() => new Date());
    this.#approvalTtlMs = options.approvalTtlMs ?? 12 * 60 * 60_000;
    this.#digestKey = options.digestKey ?? randomBytes(32);
    this.#log = options.log ?? (entry => console.log(JSON.stringify(entry)));
    // A prepared run whose prompt was lost with the previous process was never sent: fail it explicitly.
    for (const run of this.#store.runsWithStatus(["prepared"])) {
      this.#move(run.runId, "failed", { reasonCode: "not_dispatched_before_restart" });
    }
  }

  /** Refresh discovery server-side and require the exact VM to be a running, non-orphaned Codex VM of the project. */
  async revalidate(vmName: string, projectId?: string): Promise<ExecutionTarget> {
    const snapshot = await this.#refresh();
    const vm = snapshot.vms.find(item => item.vm_name === vmName);
    if (!vm || vm.provider !== "codex" || vm.state !== "running" || vm.orphaned || !snapshot.projects.includes(vm.project) ||
      (projectId !== undefined && vm.project !== projectId)) {
      throw new SafeError("target_unavailable");
    }
    return { provider: "codex", projectId: vm.project, vmName: vm.vm_name, vmInstanceId: null, discoveryVersion: snapshot.observed_at };
  }

  async listThreads(target: ExecutionTarget): Promise<ThreadView[]> {
    const live = await this.#ensure(target);
    const { sessions } = await live.connection.listSessions(undefined, 25);
    return sessions.map(item => ({ id: item.ref.id, status: item.status, updatedAt: item.updatedAt,
      sessionId: this.#store.findSession(target, item.ref.id)?.sessionId ?? null }));
  }

  async openSession(target: ExecutionTarget, mode: "new" | "resume", threadId?: string): Promise<SessionRecord> {
    const live = await this.#ensure(target);
    const ref = mode === "new" ? await live.connection.startSession({ mode: "new" })
      : await live.connection.resumeSession({ id: threadId ?? "" });
    live.loaded.add(ref.id);
    const existing = this.#store.findSession(target, ref.id);
    if (existing) { this.#store.touchSession(existing.sessionId, this.#iso()); return existing; }
    const at = this.#iso();
    return this.#store.createSession({ sessionId: `ses-${randomUUID()}`, target, providerSessionId: ref.id, createdAt: at, lastObservedAt: at });
  }

  async history(session: SessionRecord): Promise<HistoryPage> {
    const target = await this.revalidate(session.target.vmName, session.target.projectId);
    const live = await this.#ensure(target);
    return live.connection.history({ id: session.providerSessionId });
  }

  /** Idempotent: the same key and prompt return the same run; a new key while the project is busy is refused. */
  async startRun(session: SessionRecord, prompt: string, idempotencyKey: string): Promise<{ run: RunRecord; created: boolean }> {
    if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > MAX_PROMPT_CHARS || prompt.includes("\0")) {
      throw new SafeError("invalid_prompt");
    }
    const requestDigest = this.#digest(`${session.sessionId}\0${prompt}`);
    // A retry with a known key returns the original run even if the VM is down now: never push the user to re-send.
    const prior = this.#store.findRunByKey(session.sessionId, idempotencyKey);
    if (prior) {
      if (prior.requestDigest !== requestDigest) throw new SafeError("idempotency_key_conflict");
      return { run: prior, created: false };
    }
    const target = await this.revalidate(session.target.vmName, session.target.projectId);
    const result = this.#store.beginRun({
      runId: `run-${randomUUID()}`, sessionId: session.sessionId, idempotencyKey,
      requestDigest, createdAt: this.#iso(), exclusiveProject: session.target.projectId,
    });
    if (result.created) {
      this.#hub.journal();
      void this.#dispatch(result.run, session, target, prompt);
    }
    return result;
  }

  async interrupt(run: RunRecord, session: SessionRecord): Promise<RunRecord> {
    if (TERMINAL.includes(run.status)) return run;
    const active = this.#active.get(this.#key(session.target.vmName, session.providerSessionId));
    if (run.status === "unknown" || !active || active.runId !== run.runId || !active.providerRunId || active.live.closed) {
      throw new SafeError("run_not_interruptible");
    }
    await active.live.connection.interrupt({ sessionId: session.providerSessionId, id: active.providerRunId });
    this.#store.appendJournal({ eventId: `${run.runId}:int:${randomUUID()}`, runId: run.runId, type: "operation.notice", occurredAt: this.#iso(), payload: { reasonCode: "interrupt_requested" } });
    this.#hub.journal();
    return this.#store.getRun(run.runId) ?? run;
  }

  async reconcile(run: RunRecord, session: SessionRecord): Promise<RunRecord> {
    if (run.status !== "unknown" || !run.providerRunId) return run;
    const target = await this.revalidate(session.target.vmName, session.target.projectId);
    const live = await this.#ensure(target);
    const result = await live.connection.reconcile({ sessionId: session.providerSessionId, id: run.providerRunId });
    this.#log({ event: "run.reconciled", run_id: run.runId, outcome: result.status });
    if (result.status === "running") {
      const key = this.#key(target.vmName, session.providerSessionId);
      const other = this.#store.activeRunForProject(session.target.projectId);
      if (this.#active.has(key) || (other && other.runId !== run.runId)) throw new SafeError("project_busy");
      if (!live.loaded.has(session.providerSessionId)) {
        await live.connection.resumeSession({ id: session.providerSessionId });
        live.loaded.add(session.providerSessionId);
      }
      if (this.#active.has(key) || this.#store.activeRunForProject(session.target.projectId)) throw new SafeError("project_busy");
      this.#active.set(key, { runId: run.runId, session, live, providerRunId: run.providerRunId, buffer: [] });
      return this.#move(run.runId, "running", { reasonCode: "reconciled" }) ?? run;
    }
    if (result.status === "unknown") return run;
    return this.#move(run.runId, result.status, { reasonCode: "reconciled" }) ?? run;
  }

  approvalView(approval: ApprovalRecord): ApprovalView | null {
    const run = this.#store.getRun(approval.runId);
    const session = run ? this.#store.getSession(run.sessionId) : null;
    if (!run || !session) return null;
    const pending = this.#approvals.get(approval.approvalId);
    return { ...approval, projectId: session.target.projectId, sessionId: session.sessionId, vmName: session.target.vmName,
      summary: pending && !pending.live.closed ? pending.summary : null };
  }

  async decide(approval: ApprovalRecord, decision: "approve" | "reject", expectedVersion: number): Promise<ApprovalRecord> {
    const pending = this.#approvals.get(approval.approvalId);
    if (approval.status === "pending" && (!pending || pending.live.closed)) {
      // The provider handle died with its connection or process: the request can never be answered now.
      this.#store.expireApproval(approval.approvalId, "provider_handle_lost", this.#iso());
      this.#approvals.delete(approval.approvalId);
      this.#hub.journal();
      throw new SafeError("approval_expired");
    }
    let outcome: { approval: ApprovalRecord; changed: boolean };
    try {
      outcome = this.#store.resolveApproval(approval.approvalId, expectedVersion, decision === "approve" ? "approved" : "denied", this.#iso());
    } catch (error) {
      if (error instanceof SafeError && error.code === "approval_expired") {
        this.#store.expireApproval(approval.approvalId, "ttl_elapsed", this.#iso());
        this.#approvals.delete(approval.approvalId);
        this.#hub.journal();
      }
      throw error;
    }
    const { approval: resolved, changed } = outcome;
    if (!changed || !pending) return resolved;
    this.#approvals.delete(approval.approvalId);
    this.#hub.journal();
    try {
      await pending.live.connection.decideApproval(pending.ref, decision);
      this.#log({ event: "approval.decided", run_id: pending.runId, outcome: resolved.status });
    } catch (error) {
      this.#log({ event: "approval.decided", run_id: pending.runId, outcome: "delivery_unconfirmed", error_code: safeCode(error) });
      this.#move(pending.runId, "unknown", { reasonCode: "approval_delivery_unconfirmed" });
      return resolved;
    }
    const run = this.#store.getRun(pending.runId);
    if (run?.status === "awaiting_approval" && ![...this.#approvals.values()].some(item => item.runId === run.runId)) {
      this.#move(run.runId, "running");
    }
    return resolved;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#connections.values()]);
    for (const live of [...this.#lives.values()]) await this.#lost(live, "cockpit_shutdown");
  }

  // ---------------------------------------------------------------------------------------------

  async #dispatch(prepared: RunRecord, session: SessionRecord, target: ExecutionTarget, prompt: string): Promise<void> {
    const started = performance.now();
    const key = this.#key(target.vmName, session.providerSessionId);
    let sent = false;
    let live: Live | undefined;
    try {
      if (!this.#move(prepared.runId, "dispatching")) throw new SafeError("run_version_conflict");
      live = await this.#ensure(target);
      if (!live.loaded.has(session.providerSessionId)) {
        await live.connection.resumeSession({ id: session.providerSessionId });
        live.loaded.add(session.providerSessionId);
      }
      if (this.#active.has(key)) throw new SafeError("session_busy");
      this.#active.set(key, { runId: prepared.runId, session, live, providerRunId: null, buffer: [] });
      sent = true; // from here on the provider may have received the prompt
      const ref = await live.connection.startRun({ session: { id: session.providerSessionId }, prompt });
      const active = this.#active.get(key);
      const current = this.#store.getRun(prepared.runId);
      if (current?.status === "dispatching") this.#move(prepared.runId, "running", { providerRunId: ref.id });
      if (active?.runId === prepared.runId) {
        // Bind to the exact turn, then replay only the buffered events of that turn.
        active.providerRunId = ref.id;
        const buffered = active.buffer.splice(0);
        for (const event of buffered) if (event.runId === ref.id) this.#onEvent(live, event);
      }
      this.#log({ event: "run.dispatched", run_id: prepared.runId, outcome: "accepted", duration_ms: Math.round(performance.now() - started) });
    } catch (error) {
      const code = safeCode(error);
      const current = this.#store.getRun(prepared.runId);
      if (this.#active.get(key)?.runId === prepared.runId && !sent) this.#active.delete(key);
      if (current && (current.status === "dispatching" || current.status === "prepared")) {
        if (sent) {
          this.#active.delete(key);
          this.#move(prepared.runId, "unknown", { reasonCode: "dispatch_unconfirmed" });
        } else {
          this.#move(prepared.runId, "failed", { reasonCode: code.length <= 64 && /^[a-z][a-z0-9_]*$/.test(code) ? code : "dispatch_failed" });
        }
      }
      this.#log({ event: "run.dispatch_failed", run_id: prepared.runId, outcome: sent ? "unknown" : "failed", error_code: code });
    }
  }

  #ensure(target: ExecutionTarget): Promise<Live> {
    if (this.#closed) return Promise.reject(new SafeError("cockpit_shutting_down"));
    const existing = this.#connections.get(target.vmName);
    if (existing) return existing;
    const pending = (async () => {
      const connection = await this.#adapter.connect(target);
      let identity: ProtocolIdentity;
      try { identity = await connection.initialize(); }
      catch (error) { await connection.close().catch(() => {}); throw error; }
      const live: Live = { vmName: target.vmName, connection, identity, loaded: new Set(), closed: false, files: new Map() };
      this.#lives.set(target.vmName, live);
      this.#log({ event: "provider.connected", outcome: identity.serverVersion });
      void this.#pump(live);
      return live;
    })();
    this.#connections.set(target.vmName, pending);
    pending.catch(error => {
      if (this.#connections.get(target.vmName) === pending) this.#connections.delete(target.vmName);
      this.#log({ event: "provider.connect_failed", error_code: safeCode(error) });
    });
    return pending;
  }

  async #pump(live: Live): Promise<void> {
    let reason = "transport_lost";
    try {
      for await (const event of live.connection.events()) {
        try { this.#onEvent(live, event); }
        catch (error) { this.#log({ event: "run.transport_lost", outcome: "event_handling_failed", error_code: safeCode(error) }); }
      }
    } catch (error) { reason = "transport_lost"; this.#log({ event: "run.transport_lost", error_code: safeCode(error) }); }
    await this.#lost(live, reason);
  }

  async #lost(live: Live, reasonCode: string): Promise<void> {
    if (live.closed) return;
    live.closed = true;
    if (this.#lives.get(live.vmName) === live) {
      this.#lives.delete(live.vmName);
      this.#connections.delete(live.vmName);
    }
    for (const [key, active] of this.#active) {
      if (active.live !== live) continue;
      this.#active.delete(key);
      const run = this.#store.getRun(active.runId);
      if (run && UNCERTAIN.includes(run.status)) this.#move(run.runId, "unknown", { reasonCode });
      this.#store.expireApprovals(active.runId, reasonCode, this.#iso());
      this.#log({ event: "run.transport_lost", run_id: active.runId, outcome: "unknown" });
    }
    for (const [id, pending] of this.#approvals) if (pending.live === live) this.#approvals.delete(id);
    this.#hub.journal();
    await live.connection.close().catch(() => {});
  }

  #onEvent(live: Live, event: ProviderEvent): void {
    if (event.type === "session.connected" || event.type === "session.resumed") return;
    if (event.type === "approval.resolved") {
      for (const [id, pending] of this.#approvals) {
        if (pending.live === live && pending.ref.requestId === event.requestId) {
          this.#approvals.delete(id);
          this.#store.expireApproval(id, "provider_resolved", this.#iso());
          this.#hub.journal();
        }
      }
      return;
    }
    const active = this.#active.get(this.#key(live.vmName, event.sessionId));
    if (!active || active.live !== live) return; // activity not started by the Cockpit is not attributed
    if (event.runId && !active.providerRunId) {
      // Turn id not known yet (turn/start in flight): never attribute another turn's events to this run.
      if (active.buffer.length < 2000) active.buffer.push(event);
      return;
    }
    if (event.runId && active.providerRunId && event.runId !== active.providerRunId) return;
    const session = active.session;
    const base = { projectId: session.target.projectId, sessionId: session.sessionId, runId: active.runId };
    this.#store.touchSession(session.sessionId, this.#iso());
    switch (event.type) {
      case "run.started": {
        active.providerRunId ??= event.runId;
        const run = this.#store.getRun(active.runId);
        if (run?.status === "dispatching") this.#move(active.runId, "running", { providerRunId: event.runId });
        return;
      }
      case "run.output_delta":
        this.#hub.live({ ...base, kind: "delta", data: { itemId: event.itemId, delta: event.delta } });
        return;
      case "run.item":
        if (event.item.kind === "file_change") live.files.set(event.item.id, event.item.files);
        this.#hub.live({ ...base, kind: "item", data: { phase: event.phase, item: event.item } });
        return;
      case "usage.updated":
        this.#store.recordUsage(active.runId, event, this.#iso());
        return;
      case "run.error":
        this.#hub.live({ ...base, kind: "error", data: { message: event.message, willRetry: event.willRetry, errorClass: event.errorClass ?? null } });
        if (!event.willRetry) {
          if (event.errorClass) active.errorClass = event.errorClass;
          this.#store.appendJournal({ eventId: `${active.runId}:err:${randomUUID()}`, runId: active.runId, type: "operation.notice", occurredAt: this.#iso(), payload: { reasonCode: event.errorClass ? ERROR_REASON[event.errorClass] : "provider_turn_error" } });
          this.#hub.journal();
        }
        return;
      case "request.unsupported":
        this.#store.appendJournal({ eventId: `${active.runId}:unsup:${randomUUID()}`, runId: active.runId, type: "operation.notice", occurredAt: this.#iso(), payload: { reasonCode: "provider_request_unsupported" } });
        this.#hub.live({ ...base, kind: "notice", data: { code: "provider_request_unsupported", method: event.method } });
        this.#hub.journal();
        return;
      case "approval.requested": {
        const approvalId = `apr-${randomUUID()}`;
        const at = this.#now();
        const files = event.summary.itemId ? live.files.get(event.summary.itemId) ?? [] : [];
        const summary = { ...event.summary, files };
        this.#store.createApproval({ approvalId, runId: active.runId, actionType: summary.actionType,
          actionDigest: this.#digest(JSON.stringify([active.runId, String(event.approval.requestId), summary])),
          createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + this.#approvalTtlMs).toISOString() });
        this.#approvals.set(approvalId, { approvalId, runId: active.runId, live, ref: event.approval, summary });
        const run = this.#store.getRun(active.runId);
        if (run?.status === "running") this.#move(active.runId, "awaiting_approval");
        else this.#hub.journal();
        this.#hub.live({ ...base, kind: "approval", data: { approvalId } });
        return;
      }
      case "run.status_changed": {
        if (!TERMINAL.includes(event.status) && event.status !== "unknown") return;
        this.#active.delete(this.#key(live.vmName, event.sessionId));
        for (const [id, pending] of this.#approvals) if (pending.runId === active.runId) this.#approvals.delete(id);
        this.#store.expireApprovals(active.runId, "run_ended", this.#iso());
        const reasonCode = event.status === "unknown" ? "provider_status_unknown" : event.status === "failed" ? failureReason(event.errorClass ?? active.errorClass) : undefined;
        const run = this.#store.getRun(active.runId);
        if (run?.status === "dispatching" && event.runId) this.#move(active.runId, "running", { providerRunId: event.runId });
        this.#move(active.runId, event.status, reasonCode ? { reasonCode } : {});
        this.#hub.live({ ...base, kind: "status", data: { status: event.status, errorMessage: event.errorMessage ?? null, reasonCode: reasonCode ?? null } });
        this.#log({ event: "run.finished", run_id: active.runId, outcome: event.status });
        return;
      }
    }
  }

  #move(runId: string, next: RunStatus, options: { providerRunId?: string; reasonCode?: string } = {}): RunRecord | null {
    const current = this.#store.getRun(runId);
    if (!current) return null;
    if (current.status === next && options.providerRunId === undefined) return current;
    try {
      const updated = this.#store.transition(runId, current.lifecycleVersion, next, this.#iso(), options);
      this.#hub.journal();
      return updated;
    } catch { return null; }
  }

  #digest(value: string): string { return createHmac("sha256", this.#digestKey).update(value, "utf8").digest("hex"); }
  #key(vmName: string, providerSessionId: string): string { return `${vmName}\0${providerSessionId}`; }
  #iso(): string { return this.#now().toISOString(); }
}

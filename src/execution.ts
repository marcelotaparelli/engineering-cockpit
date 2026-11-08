import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { assertNoSymlinks } from "./paths.ts";
import { SafeError, safeCode, type Provider, type Snapshot } from "./model.ts";
import type { EventHub } from "./event-hub.ts";
import type {
  ApprovalSummary, ExecutionTarget, HistoryPage, ProtocolIdentity, ProviderAdapter, ProviderApprovalRef, ProviderCapabilities,
  ProviderConnection, ProviderErrorClass, ProviderEvent, ProviderSessionSummary, RunStatus,
} from "./provider.ts";
import type { ApprovalRecord, RunRecord, RuntimeStore, SessionRecord } from "./runtime-store.ts";
import type { OrphanProcess } from "./process-ledger.ts";
import { activityEntry, approvalEntry, partialMessageEntry, userMessageEntry, type TranscriptEntry } from "./transcript.ts";

export interface ExecutionLog {
  event: "run.dispatched" | "run.dispatch_failed" | "run.dispatch_blocked" | "run.finished" | "run.transport_lost" | "approval.decided" | "provider.connected" | "provider.connect_failed" | "run.reconciled" | "transcript.write_failed"
    | "run.loss_classified" | "run.transition_rejected";
  run_id?: string;
  outcome?: string;
  error_code?: string;
  /** Closed vocabulary (`[a-z_]`); never provider text. */
  reason_code?: string;
  provider?: Provider;
  duration_ms?: number;
}

export interface ExecutionOptions {
  store: RuntimeStore;
  /** One adapter per provider. `adapter` is the single-provider shorthand. */
  adapter?: ProviderAdapter;
  adapters?: readonly ProviderAdapter[];
  hub: EventHub;
  refresh: () => Promise<Snapshot>;
  now?: () => Date;
  approvalTtlMs?: number;
  /** Per-install secret for HMAC digests of prompts/actions (kept outside the database). */
  digestKey?: Uint8Array;
  log?: (entry: ExecutionLog) => void;
  /** E4: msb children that outlived a previous Cockpit. A run never starts beside one of its session/VM. */
  processes?: { blocking(vmName: string, providerSessionId: string): OrphanProcess | null; orphans(): OrphanProcess[] };
  /** Re-persist interval of streamed partial text (E3.1/E4). Default 1000 ms. */
  partialFlushMs?: number;
}

export interface ApprovalView extends ApprovalRecord {
  projectId: string;
  sessionId: string;
  vmName: string;
  summary: (ApprovalSummary & { files: string[] }) | null;
}

/** Result of an explicit reconciliation: `confirmed` means the provider gave evidence; anything else leaves the run `unknown`. */
export interface ReconcileOutcome { result: "confirmed" | "unconfirmed" | "not_applicable"; reasonCode: string }
/** Process-lifetime counters (E4). Codes and counts only. */
export interface ReliabilityCounters {
  runs_dispatched: number; dispatch_failed: number; dispatch_unconfirmed: number; dispatch_blocked_orphan: number; transport_lost: number;
  provider_session_lost: number; vm_stopped: number; approval_delivery_unconfirmed: number; transitions_rejected: number;
  transcript_write_failed: number; reconcile_confirmed: number; reconcile_unconfirmed: number;
}
/** Run `unknown` reasons that only say "the handle died": discovery may later show the VM itself was down. */
const LOSS_REASONS: readonly string[] = ["transport_lost", "provider_session_lost"];
/** File-change items remembered per connection to label approvals (Codex sends files on the item, not on the request). */
const MAX_TRACKED_FILE_ITEMS = 500;

export interface ThreadView { id: string; status: ProviderSessionSummary["status"]; updatedAt: string | null; sessionId: string | null }

interface Live {
  vmName: string;
  adapter: ProviderAdapter;
  connection: ProviderConnection;
  identity: ProtocolIdentity;
  loaded: Set<string>;
  closed: boolean;
  files: Map<string, string[]>;
}
/** Streamed agent text not yet completed by the provider (E3.1): persisted early (position), then throttled. */
interface PartialText { text: string; flushedAt: number; flushedLength: number }
interface ActiveRun {
  runId: string; session: SessionRecord; live: Live; providerRunId: string | null; buffer: ProviderEvent[]; errorClass?: ProviderErrorClass;
  partials?: Map<string, PartialText>;
  /** Trailing flush of partial text when the stream pauses (tool use, approval, slow model): a kill loses at most one interval. */
  partialTimer?: ReturnType<typeof setTimeout> | undefined;
}
/** Partial agent text is re-persisted at most this often while streaming (a hard kill loses at most this much). */
const PARTIAL_FLUSH_MS = 1000;
const MAX_PARTIALS = 64;

const ERROR_REASON: Readonly<Record<ProviderErrorClass, string>> = Object.freeze({
  usage_limit: "provider_usage_limit", auth: "provider_auth_failed", transport: "provider_transport_error", context_window: "provider_context_window",
  bad_request: "provider_bad_request", overloaded: "provider_overloaded", sandbox: "provider_sandbox_error", provider_internal: "provider_internal_error",
});
export interface BlockedRequest { method: string; since: string; occurrences: number }
interface PendingApproval { approvalId: string; runId: string; live: Live; ref: ProviderApprovalRef; summary: ApprovalSummary & { files: string[] } }

const MAX_PROMPT_CHARS = 64 * 1024;
/** Adapter refusals raised before anything is written to the provider: the prompt provably did not leave the Cockpit. */
const NOT_SENT: ReadonlySet<string> = new Set(["provider_session_not_loaded", "provider_session_busy", "provider_input_invalid", "provider_connection_closed", "provider_not_initialized"]);
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
  readonly #adapters = new Map<Provider, ProviderAdapter>();
  readonly #hub: EventHub;
  readonly #refresh: () => Promise<Snapshot>;
  readonly #now: () => Date;
  readonly #approvalTtlMs: number;
  readonly #digestKey: Uint8Array;
  readonly #log: (entry: ExecutionLog) => void;
  readonly #partialFlushMs: number;
  readonly #processes: ExecutionOptions["processes"];
  readonly #startedAt: string;
  readonly #stats: ReliabilityCounters = { runs_dispatched: 0, dispatch_failed: 0, dispatch_unconfirmed: 0, dispatch_blocked_orphan: 0, transport_lost: 0,
    provider_session_lost: 0, vm_stopped: 0, approval_delivery_unconfirmed: 0, transitions_rejected: 0, transcript_write_failed: 0, reconcile_confirmed: 0, reconcile_unconfirmed: 0 };
  readonly #connections = new Map<string, Promise<Live>>();
  readonly #lives = new Map<string, Live>();
  readonly #active = new Map<string, ActiveRun>(); // key: vm \0 providerSessionId
  readonly #approvals = new Map<string, PendingApproval>();
  /** Provider requests the Cockpit cannot answer, per run. Memory-only: it describes a live process and dies with it. */
  readonly #blocked = new Map<string, Map<string, BlockedRequest>>();
  #closed = false;

  constructor(options: ExecutionOptions) {
    this.#store = options.store;
    for (const adapter of [...(options.adapter ? [options.adapter] : []), ...(options.adapters ?? [])]) {
      if (this.#adapters.has(adapter.provider)) throw new SafeError("duplicate_provider_adapter");
      this.#adapters.set(adapter.provider, adapter);
    }
    if (this.#adapters.size === 0) throw new SafeError("provider_adapter_required");
    this.#hub = options.hub;
    this.#refresh = options.refresh;
    this.#now = options.now ?? (() => new Date());
    this.#approvalTtlMs = options.approvalTtlMs ?? 12 * 60 * 60_000;
    this.#digestKey = options.digestKey ?? randomBytes(32);
    this.#log = options.log ?? (entry => console.log(JSON.stringify(entry)));
    this.#processes = options.processes;
    this.#startedAt = this.#now().toISOString();
    this.#partialFlushMs = options.partialFlushMs ?? PARTIAL_FLUSH_MS;
    if (!Number.isSafeInteger(this.#partialFlushMs) || this.#partialFlushMs < 1) throw new SafeError("invalid_partial_flush_interval");
    // A prepared run whose prompt was lost with the previous process was never sent: fail it explicitly.
    for (const run of this.#store.runsWithStatus(["prepared"])) {
      this.#move(run.runId, "failed", { reasonCode: "not_dispatched_before_restart" });
    }
  }

  /** True when a registered adapter can operate this VM (provider supported and the VM not reserved by the adapter). */
  supports(provider: Provider, vmName?: string): boolean {
    const adapter = this.#adapters.get(provider);
    return Boolean(adapter && (vmName === undefined || !adapter.acceptsTarget || adapter.acceptsTarget(vmName)));
  }

  capabilities(provider: Provider): ProviderCapabilities | null {
    const adapter = this.#adapters.get(provider);
    return adapter ? { ...adapter.capabilities } : null;
  }

  /** Refresh discovery server-side and require the exact VM to be a running, non-orphaned agent VM of the project with a registered provider. */
  async revalidate(vmName: string, projectId?: string): Promise<ExecutionTarget> {
    const snapshot = await this.#refresh();
    const vm = snapshot.vms.find(item => item.vm_name === vmName);
    if (!vm || !this.supports(vm.provider, vm.vm_name) || vm.state !== "running" || vm.orphaned || !snapshot.projects.includes(vm.project) ||
      (projectId !== undefined && vm.project !== projectId)) {
      throw new SafeError("target_unavailable");
    }
    return { provider: vm.provider, projectId: vm.project, vmName: vm.vm_name, vmInstanceId: null, discoveryVersion: snapshot.observed_at };
  }

  async listThreads(target: ExecutionTarget): Promise<ThreadView[]> {
    const live = await this.#ensure(target);
    const { sessions } = await live.connection.listSessions(undefined, 25);
    return sessions.map(item => ({ id: item.ref.id, status: item.status, updatedAt: item.updatedAt,
      sessionId: this.#store.findSession(target, item.ref.id)?.sessionId ?? null }));
  }

  async openSession(target: ExecutionTarget, mode: "new" | "resume", threadId?: string): Promise<SessionRecord> {
    const live = await this.#ensure(target);
    const known = mode === "resume" && threadId ? this.#store.findSession(target, threadId) : null;
    const ref = mode === "new" ? await live.connection.startSession({ mode: "new" })
      : await live.connection.resumeSession({ id: threadId ?? "" }, known ? this.#resumeHints(known) : undefined);
    live.loaded.add(ref.id);
    const existing = this.#store.findSession(target, ref.id);
    if (existing) { this.#store.touchSession(existing.sessionId, this.#iso()); return existing; }
    const at = this.#iso();
    return this.#store.createSession({ sessionId: `ses-${randomUUID()}`, target, providerSessionId: ref.id, createdAt: at, lastObservedAt: at });
  }

  /**
   * Conversation of a session. Providers that cannot read their own transcript (`history: "cockpit"`) are served from the
   * RuntimeStore only: no provider call, no VM needed, identical after a Cockpit restart.
   */
  async history(session: SessionRecord, cursor?: string, limit?: number): Promise<HistoryPage> {
    if (this.#persistsHistory(session.target.provider)) {
      if (cursor !== undefined && !/^[1-9][0-9]{0,15}$/.test(cursor)) throw new SafeError("invalid_history_cursor");
      const page = this.#store.transcriptPage(session.sessionId, cursor === undefined ? undefined : Number(cursor), limit);
      return { items: page.items, runs: [], nextCursor: page.nextCursor };
    }
    if (cursor !== undefined) throw new SafeError("invalid_history_cursor");
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
    // E4: a process of the previous Cockpit may still be running a turn of this session (Claude) or VM (Codex app-server).
    // Starting another one beside it would be a second, unsupervised agent: refused until the orphan is gone. Nothing is sent.
    const orphan = this.#processes?.blocking(session.target.vmName, session.providerSessionId) ?? null;
    if (orphan) {
      this.#stats.dispatch_blocked_orphan++;
      this.#log({ event: "run.dispatch_blocked", outcome: orphan.kind, error_code: "orphan_process_alive" });
      throw new SafeError("orphan_process_alive");
    }
    const target = await this.revalidate(session.target.vmName, session.target.projectId);
    const result = this.#store.beginRun({
      runId: `run-${randomUUID()}`, sessionId: session.sessionId, idempotencyKey,
      requestDigest, createdAt: this.#iso(), exclusiveProject: session.target.projectId,
    });
    if (result.created) {
      // The operator's message is part of the conversation from the moment the run exists, whatever happens to it.
      if (this.#persistsHistory(session.target.provider)) this.#record(session.sessionId, result.run.runId, userMessageEntry(result.run.runId, prompt));
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

  /**
   * Explicit, operator-triggered look at an `unknown` run. Only provider evidence moves it; otherwise it stays `unknown` and the
   * outcome says why. Nothing is ever resent. Providers that can confirm a run only through its live process
   * (`reconcile: "process"`, Claude Code) are not even contacted once that process is gone: a fresh connection knows nothing.
   */
  async reconcile(run: RunRecord, session: SessionRecord): Promise<{ run: RunRecord; outcome: ReconcileOutcome }> {
    if (run.status !== "unknown") return { run, outcome: { result: "not_applicable", reasonCode: "run_not_unknown" } };
    const unconfirmed = (reasonCode: string) => {
      this.#stats.reconcile_unconfirmed++;
      this.#log({ event: "run.reconciled", run_id: run.runId, outcome: "unconfirmed", reason_code: reasonCode, provider: session.target.provider });
      return { run: this.#store.getRun(run.runId) ?? run, outcome: { result: "unconfirmed" as const, reasonCode } };
    };
    // The prompt may have reached the provider, but no run id ever came back: there is nothing to look up.
    if (!run.providerRunId) return unconfirmed("provider_run_unbound");
    const adapter = this.#adapters.get(session.target.provider);
    const current = this.#lives.get(session.target.vmName);
    if (adapter?.capabilities.reconcile === "process" && (!current || current.closed || !current.loaded.has(session.providerSessionId))) {
      return unconfirmed("provider_cannot_confirm");
    }
    const target = await this.revalidate(session.target.vmName, session.target.projectId);
    const live = await this.#ensure(target);
    const result = await live.connection.reconcile({ sessionId: session.providerSessionId, id: run.providerRunId });
    this.#log({ event: "run.reconciled", run_id: run.runId, outcome: result.status, provider: session.target.provider });
    if (result.status === "running") {
      const key = this.#key(target.vmName, session.providerSessionId);
      const other = this.#store.activeRunForProject(session.target.projectId);
      if (this.#active.has(key) || (other && other.runId !== run.runId)) throw new SafeError("project_busy");
      if (!live.loaded.has(session.providerSessionId)) {
        await live.connection.resumeSession({ id: session.providerSessionId }, this.#resumeHints(session));
        live.loaded.add(session.providerSessionId);
      }
      if (this.#active.has(key) || this.#store.activeRunForProject(session.target.projectId)) throw new SafeError("project_busy");
      this.#active.set(key, { runId: run.runId, session, live, providerRunId: run.providerRunId, buffer: [] });
      this.#stats.reconcile_confirmed++;
      return { run: this.#move(run.runId, "running", { reasonCode: "reconciled" }) ?? run, outcome: { result: "confirmed", reasonCode: "reconciled" } };
    }
    if (result.status === "unknown") return unconfirmed("provider_reports_unknown");
    this.#stats.reconcile_confirmed++;
    return { run: this.#move(run.runId, result.status, { reasonCode: "reconciled" }) ?? run, outcome: { result: "confirmed", reasonCode: "reconciled" } };
  }

  /** Counters since this process started, plus current gauges. Codes and counts only (no ids, names or content). */
  reliability(): Record<string, number | string> {
    return { since: this.#startedAt, ...this.#stats, orphan_processes: this.orphanProcesses().length, provider_connections: this.#lives.size,
      active_runs: this.#active.size, approval_handles: this.#approvals.size };
  }

  /** Unsupported provider requests currently holding this run, deduplicated by method. Empty when none. */
  blockedRequests(runId: string): BlockedRequest[] {
    const run = this.#store.getRun(runId);
    if (!run || TERMINAL.includes(run.status) || run.status === "unknown") return [];
    return [...(this.#blocked.get(runId)?.values() ?? [])];
  }

  /** Orphaned msb children of a previous Cockpit that are still alive (re-probed on every call). */
  orphanProcesses(): OrphanProcess[] { return this.#processes?.orphans() ?? []; }

  approvalView(approval: ApprovalRecord): ApprovalView | null {
    const run = this.#store.getRun(approval.runId);
    const session = run ? this.#store.getSession(run.sessionId) : null;
    if (!run || !session) return null;
    const pending = this.#approvals.get(approval.approvalId);
    return { ...approval, projectId: session.target.projectId, sessionId: session.sessionId, vmName: session.target.vmName,
      summary: pending && !pending.live.closed ? pending.summary : null };
  }

  async decide(given: ApprovalRecord, decision: "approve" | "reject", expectedVersion: number, answers?: Record<string, string>): Promise<ApprovalRecord> {
    // Always the stored state, never the caller's copy: a replay with a stale record must see the decision already taken
    // (identical replay = no-op, anything else = conflict) instead of being mistaken for a lost provider handle.
    const approval = this.#store.getApproval(given.approvalId) ?? given;
    // Answers belong only to an approved question; a question is never "approved" without them.
    if (approval.actionType === "question" ? (decision === "approve") !== (answers !== undefined) : answers !== undefined) throw new SafeError("invalid_body");
    const pending = this.#approvals.get(approval.approvalId);
    if (answers !== undefined && pending) {
      // Validate before any state change: a malformed answer must never resolve the approval or put the run in doubt.
      const expected = (pending.summary.questions ?? []).map(item => item.question);
      const keys = Object.keys(answers);
      if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) throw new SafeError("invalid_body");
    }
    if (approval.status === "pending" && (!pending || pending.live.closed)) {
      // The provider handle died with its connection or process: the request can never be answered now.
      this.#store.expireApproval(approval.approvalId, "provider_handle_lost", this.#iso());
      this.#approvals.delete(approval.approvalId);
      this.#hub.journal();
      throw new SafeError("approval_expired");
    }
    let outcome: { approval: ApprovalRecord; changed: boolean };
    try {
      outcome = this.#store.resolveApproval(approval.approvalId, expectedVersion, decision === "approve" ? "approved" : "denied", this.#iso(),
        approval.actionType === "question" && decision === "approve" ? "human_answer" : "human_decision");
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
    if (answers !== undefined && this.#persistsHistory(pending.live.adapter.provider)) {
      const run = this.#store.getRun(pending.runId);
      if (run) this.#record(run.sessionId, run.runId, approvalEntry(approval.approvalId, pending.summary, answers), approval.approvalId);
    }
    this.#approvals.delete(approval.approvalId);
    this.#hub.journal();
    try {
      await pending.live.connection.decideApproval(pending.ref, answers === undefined ? { decision } : { decision, answers });
      this.#log({ event: "approval.decided", run_id: pending.runId, outcome: resolved.status });
    } catch (error) {
      this.#stats.approval_delivery_unconfirmed++;
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
        await live.connection.resumeSession({ id: session.providerSessionId }, this.#resumeHints(session, prepared.runId));
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
      this.#stats.runs_dispatched++;
      this.#log({ event: "run.dispatched", run_id: prepared.runId, outcome: "accepted", provider: target.provider, duration_ms: Math.round(performance.now() - started) });
    } catch (error) {
      const code = safeCode(error);
      const current = this.#store.getRun(prepared.runId);
      if (this.#active.get(key)?.runId === prepared.runId && !sent) this.#active.delete(key);
      if (current && (current.status === "dispatching" || current.status === "prepared")) {
        if (sent && !NOT_SENT.has(code)) {
          this.#active.delete(key);
          this.#move(prepared.runId, "unknown", { reasonCode: "dispatch_unconfirmed" });
        } else {
          if (sent && this.#active.get(key)?.runId === prepared.runId) this.#active.delete(key);
          this.#move(prepared.runId, "failed", { reasonCode: code.length <= 64 && /^[a-z][a-z0-9_]*$/.test(code) ? code : "dispatch_failed" });
        }
      }
      const unconfirmed = sent && !NOT_SENT.has(code);
      if (unconfirmed) this.#stats.dispatch_unconfirmed++; else this.#stats.dispatch_failed++;
      this.#log({ event: "run.dispatch_failed", run_id: prepared.runId, outcome: unconfirmed ? "unknown" : "failed", error_code: code, provider: target.provider });
    }
  }

  #ensure(target: ExecutionTarget): Promise<Live> {
    if (this.#closed) return Promise.reject(new SafeError("cockpit_shutting_down"));
    const existing = this.#connections.get(target.vmName);
    if (existing) return existing;
    const adapter = this.#adapters.get(target.provider);
    if (!adapter) return Promise.reject(new SafeError("target_unavailable"));
    const pending = (async () => {
      const connection = await adapter.connect(target);
      let identity: ProtocolIdentity;
      try { identity = await connection.initialize(); }
      catch (error) { await connection.close().catch(() => {}); throw error; }
      const live: Live = { vmName: target.vmName, adapter, connection, identity, loaded: new Set(), closed: false, files: new Map() };
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
    const uncertain: string[] = [];
    for (const [key, active] of this.#active) {
      if (active.live !== live) continue;
      this.#flushPartials(active);
      this.#active.delete(key);
      this.#blocked.delete(active.runId);
      const run = this.#store.getRun(active.runId);
      if (run && UNCERTAIN.includes(run.status) && this.#move(run.runId, "unknown", { reasonCode })) uncertain.push(run.runId);
      this.#store.expireApprovals(active.runId, reasonCode, this.#iso());
      if (reasonCode === "transport_lost") this.#stats.transport_lost++;
      this.#log({ event: "run.transport_lost", run_id: active.runId, outcome: "unknown", reason_code: reasonCode, provider: live.adapter.provider });
    }
    for (const [id, pending] of this.#approvals) if (pending.live === live) this.#approvals.delete(id);
    this.#hub.journal();
    if (uncertain.length && LOSS_REASONS.includes(reasonCode)) void this.#classifyLoss(live.vmName, uncertain);
    await live.connection.close().catch(() => {});
  }

  /**
   * E4: a lost connection/process says nothing about WHY. Discovery is asked once, right after the loss: a VM that is no
   * longer running turns the reason into `vm_stopped`. A running VM, or a failed discovery, leaves the reason as it was.
   */
  async #classifyLoss(vmName: string, runIds: readonly string[]): Promise<void> {
    let snapshot: Snapshot;
    try { snapshot = await this.#refresh(); }
    catch (error) { this.#log({ event: "run.loss_classified", outcome: "discovery_failed", error_code: safeCode(error) }); return; }
    const vm = snapshot.vms.find(item => item.vm_name === vmName);
    if (vm && vm.state === "running") { this.#log({ event: "run.loss_classified", outcome: "vm_running" }); return; }
    for (const runId of runIds) {
      try {
        if (!this.#store.refineUnknownReason(runId, LOSS_REASONS, "vm_stopped", this.#iso())) continue;
        this.#stats.vm_stopped++;
        this.#log({ event: "run.loss_classified", run_id: runId, outcome: "vm_stopped", reason_code: "vm_stopped" });
      } catch (error) { this.#log({ event: "run.loss_classified", run_id: runId, outcome: "not_recorded", error_code: safeCode(error) }); }
    }
    try { this.#hub.journal(); } catch { /* subscribers are isolated */ }
  }

  #onEvent(live: Live, event: ProviderEvent): void {
    if (event.type === "session.connected" || event.type === "session.resumed") return;
    if (event.type === "session.lost") { this.#sessionLost(live, event.sessionId, event.reason); return; }
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
        if (this.#persistsHistory(live.adapter.provider)) this.#partial(active, event.itemId, event.delta);
        return;
      case "run.item":
        if (event.item.kind === "file_change") {
          // Bounded: a long-lived connection must not remember every file change it ever saw.
          if (!live.files.has(event.item.id) && live.files.size >= MAX_TRACKED_FILE_ITEMS) live.files.delete(live.files.keys().next().value!);
          live.files.set(event.item.id, event.item.files);
        }
        this.#hub.live({ ...base, kind: "item", data: { phase: event.phase, item: event.item } });
        if (this.#persistsHistory(live.adapter.provider)) {
          // Started agent messages/reasoning carry no content yet: their deltas or final form are recorded instead.
          const skip = event.phase === "started" && (event.item.kind === "agent_message" || event.item.kind === "reasoning");
          const entry = skip ? null : activityEntry(event.item, event.phase);
          if (entry) {
            if (entry.kind === "agent_message" && entry.complete) active.partials?.delete(event.item.id);
            this.#record(session.sessionId, active.runId, entry);
          }
        }
        return;
      case "usage.updated":
        this.#store.recordUsage(active.runId, event, this.#iso(), live.adapter.capabilities.usage === "run" ? "run" : "session_cumulative");
        return;
      case "run.error":
        this.#hub.live({ ...base, kind: "error", data: { message: event.message, willRetry: event.willRetry, errorClass: event.errorClass ?? null } });
        if (!event.willRetry) {
          if (event.errorClass) active.errorClass = event.errorClass;
          this.#store.appendJournal({ eventId: `${active.runId}:err:${randomUUID()}`, runId: active.runId, type: "operation.notice", occurredAt: this.#iso(), payload: { reasonCode: event.errorClass ? ERROR_REASON[event.errorClass] : "provider_turn_error" } });
          this.#hub.journal();
        }
        return;
      case "request.unsupported": {
        // Equivalent requests (same method, same run) are one blockage: count them, notify once.
        const method = /^[A-Za-z0-9/_.-]{1,128}$/.test(event.method) ? event.method : "unknown_method";
        const entries = this.#blocked.get(active.runId) ?? new Map<string, BlockedRequest>();
        this.#blocked.set(active.runId, entries);
        const known = entries.get(method);
        if (known) { known.occurrences += 1; return; }
        entries.set(method, { method, since: this.#iso(), occurrences: 1 });
        this.#store.appendJournal({ eventId: `${active.runId}:unsup:${method}`, runId: active.runId, type: "operation.notice", occurredAt: this.#iso(), payload: { reasonCode: "provider_request_unsupported" } });
        this.#hub.live({ ...base, kind: "notice", data: { code: "provider_request_unsupported", method } });
        this.#hub.journal();
        return;
      }
      case "approval.requested": {
        const approvalId = `apr-${randomUUID()}`;
        const at = this.#now();
        const files = event.summary.files?.length ? event.summary.files.slice(0, 50) : event.summary.itemId ? live.files.get(event.summary.itemId) ?? [] : [];
        const summary = { ...event.summary, files };
        this.#store.createApproval({ approvalId, runId: active.runId, actionType: summary.actionType,
          actionDigest: this.#digest(JSON.stringify([active.runId, String(event.approval.requestId), summary])),
          createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + this.#approvalTtlMs).toISOString() });
        this.#approvals.set(approvalId, { approvalId, runId: active.runId, live, ref: event.approval, summary });
        if (this.#persistsHistory(live.adapter.provider)) this.#record(session.sessionId, active.runId, approvalEntry(approvalId, summary), approvalId);
        const run = this.#store.getRun(active.runId);
        if (run?.status === "running") this.#move(active.runId, "awaiting_approval");
        else this.#hub.journal();
        this.#hub.live({ ...base, kind: "approval", data: { approvalId } });
        return;
      }
      case "run.status_changed": {
        if (!TERMINAL.includes(event.status) && event.status !== "unknown") return;
        this.#flushPartials(active);
        this.#active.delete(this.#key(live.vmName, event.sessionId));
        this.#blocked.delete(active.runId);
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

  /** The provider handle of one session died: its in-flight run can no longer be confirmed, its approvals never answered. */
  #sessionLost(live: Live, providerSessionId: string, reason: string): void {
    live.loaded.delete(providerSessionId);
    const key = this.#key(live.vmName, providerSessionId);
    const active = this.#active.get(key);
    if (!active || active.live !== live) return;
    this.#flushPartials(active);
    this.#active.delete(key);
    this.#blocked.delete(active.runId);
    for (const [id, pending] of this.#approvals) if (pending.runId === active.runId) this.#approvals.delete(id);
    const reasonCode = reason === "claude_turn_time_limit" ? "turn_time_limit" : "provider_session_lost";
    this.#store.expireApprovals(active.runId, reasonCode, this.#iso());
    const run = this.#store.getRun(active.runId);
    const moved = run && UNCERTAIN.includes(run.status) ? this.#move(run.runId, "unknown", { reasonCode }) : null;
    this.#hub.journal();
    this.#hub.live({ projectId: active.session.target.projectId, sessionId: active.session.sessionId, runId: active.runId, kind: "status", data: { status: "unknown", errorMessage: null, reasonCode } });
    if (reasonCode === "provider_session_lost") this.#stats.provider_session_lost++;
    this.#log({ event: "run.transport_lost", run_id: active.runId, outcome: "unknown", reason_code: reasonCode, provider: live.adapter.provider,
      error_code: /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : "provider_session_lost" });
    if (moved && LOSS_REASONS.includes(reasonCode)) void this.#classifyLoss(live.vmName, [active.runId]);
  }

  /** A transcript can exist on the provider only if some run of this session (other than `exclude`) may have reached it. */
  #resumeHints(session: SessionRecord, exclude?: string): { hasRuns: boolean } {
    const runs = this.#store.listRuns(session.sessionId, 500).filter(run => run.runId !== exclude);
    return { hasRuns: runs.some(run => run.providerRunId !== null || run.status === "unknown" || run.status === "running" || run.status === "awaiting_approval") };
  }

  #move(runId: string, next: RunStatus, options: { providerRunId?: string; reasonCode?: string } = {}): RunRecord | null {
    const current = this.#store.getRun(runId);
    if (!current) return null;
    if (current.status === next && options.providerRunId === undefined) return current;
    try {
      const updated = this.#store.transition(runId, current.lifecycleVersion, next, this.#iso(), options);
      this.#hub.journal();
      return updated;
    } catch (error) {
      // Never silent: a refused transition (e.g. a late event for a run that already ended) is counted and logged.
      this.#stats.transitions_rejected++;
      this.#log({ event: "run.transition_rejected", run_id: runId, outcome: `${current.status}_to_${next}`, error_code: safeCode(error) });
      return null;
    }
  }

  #persistsHistory(provider: Provider): boolean { return this.#adapters.get(provider)?.capabilities.history === "cockpit"; }

  /** Transcript writes never change run, approval or idempotency state: a failure is logged and the conversation goes on. */
  #record(sessionId: string, runId: string, entry: TranscriptEntry, approvalId: string | null = null): void {
    try { this.#store.recordTranscript(sessionId, runId, entry, this.#iso(), approvalId); }
    catch (error) { this.#stats.transcript_write_failed++; this.#log({ event: "transcript.write_failed", run_id: runId, error_code: safeCode(error) }); }
  }

  #partial(active: ActiveRun, itemId: string, delta: string): void {
    active.partials ??= new Map();
    let partial = active.partials.get(itemId);
    if (!partial) {
      if (active.partials.size >= MAX_PARTIALS) return;
      partial = { text: "", flushedAt: 0, flushedLength: 0 };
      active.partials.set(itemId, partial);
    }
    if (partial.text.length < 64 * 1024 + 1) partial.text += delta;
    // The first chunk is written at once so the message keeps its place in the conversation; then at most once per interval.
    const elapsed = Date.now() - partial.flushedAt;
    if (partial.flushedLength === 0 || elapsed >= this.#partialFlushMs) { this.#writePartial(active, itemId, partial); return; }
    // E4: the tail must not wait for the NEXT delta — a stream that pauses (tool call, approval, slow model) would keep it in
    // memory indefinitely and a crash would lose it. One trailing write per interval, cancelled when the run ends.
    if (!active.partialTimer) {
      active.partialTimer = setTimeout(() => {
        active.partialTimer = undefined;
        if (this.#active.get(this.#key(active.live.vmName, active.session.providerSessionId)) !== active || !active.partials) return;
        for (const [id, value] of active.partials) this.#writePartial(active, id, value);
      }, Math.max(1, this.#partialFlushMs - elapsed));
      (active.partialTimer as { unref?: () => void }).unref?.();
    }
  }

  #writePartial(active: ActiveRun, itemId: string, partial: PartialText): void {
    if (!partial.text || partial.flushedLength === partial.text.length) return;
    partial.flushedAt = Date.now();
    partial.flushedLength = partial.text.length;
    this.#record(active.session.sessionId, active.runId, partialMessageEntry(itemId, partial.text));
  }

  /** The run is ending (any way): whatever was streamed and not completed is kept, marked incomplete on read. */
  #flushPartials(active: ActiveRun): void {
    if (active.partialTimer) { clearTimeout(active.partialTimer); active.partialTimer = undefined; }
    if (!active.partials) return;
    for (const [itemId, partial] of active.partials) this.#writePartial(active, itemId, partial);
    active.partials.clear();
  }

  #digest(value: string): string { return createHmac("sha256", this.#digestKey).update(value, "utf8").digest("hex"); }
  #key(vmName: string, providerSessionId: string): string { return `${vmName}\0${providerSessionId}`; }
  #iso(): string { return this.#now().toISOString(); }
}

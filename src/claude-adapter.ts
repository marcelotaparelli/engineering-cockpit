import { randomUUID } from "node:crypto";
import { assertArchHost } from "./host.ts";
import { SafeError, safeCode, validProject, vmIdentity } from "./model.ts";
import type { JsonObject } from "./jsonl.ts";
import { minimalChildEnv, type MsbChild, type MsbSpawn } from "./msb-transport.ts";
import {
  assertClaudeTarget, claudeStreamArgv, controlError, FORBIDDEN_E2_VMS, interruptRequest, probeCapabilities, toolDecision, userMessage,
  type ClaudeErrorClass, type ClaudeEvent, type ClaudeQuestion,
} from "./claude-protocol.ts";
import { ClaudeStreamProcess, execClaudeOnce } from "./claude-process.ts";
import type {
  ActivityItem, ApprovalDecision, ApprovalSummary, ExecutionTarget, HistoryItem, HistoryPage, HistoryRun, ProtocolIdentity, ProviderAdapter,
  ProviderApprovalRef, ProviderCapabilities, ProviderConnection, ProviderErrorClass, ProviderEvent, ProviderRunRef, ProviderSessionRef,
  ProviderSessionSummary, ReconciliationResult, ResumeHints, StartRunInput, StartSessionInput,
} from "./provider.ts";

/**
 * E3 — Claude Code as a Cockpit provider, over `msb exec --stream <vm> -- claude -p --input-format stream-json ...` (E2 design).
 *
 * One ProviderConnection per VM (as for Codex); inside it, one long-lived `claude` process per open session, many turns over
 * its stdin. The Claude CLI has no turn ids, no session listing and no transcript API on this channel, so:
 *  - turn ids are minted here, one turn at a time per process (the ExecutionService already serialises runs);
 *  - sessions are only those opened through the Cockpit (`sessionListing: "cockpit"`);
 *  - history is what this process observed, bounded and memory-only (`history: "session_memory"`);
 *  - a run can be confirmed only by its live process (`reconcile: "process"`): after a crash or restart it stays `unknown`.
 * Every tool use is gated by the CLI (`--permission-mode default`) and forwarded to a human; unknown control requests are
 * answered with an error (never a permissive success); requests outside a Cockpit turn are denied.
 */
export const CLAUDE_CAPABILITIES: ProviderCapabilities = Object.freeze({
  resume: true, interrupt: true, approvals: true, questions: true,
  sessionListing: "cockpit", history: "session_memory", usage: "run", reconcile: "process",
});
export const CLAUDE_PROTOCOL = "claude-code-stream-json-v1";
/** Oldest major line whose stream-json/control surface the adapter was written against (E2: 2.1.x). */
export const MIN_CLAUDE_MAJOR = 2;

export interface ClaudeAdapterOptions {
  spawn?: MsbSpawn;
  /** Open `claude` processes per VM (one per loaded session). */
  maxSessions?: number;
  /** A process with no turn and no pending request is closed after this long; the next prompt resumes it. */
  idleMs?: number;
  /** Wall-clock limit of one turn: an interrupt is sent, then the process is killed after `turnKillGraceMs`. */
  maxTurnMs?: number;
  turnKillGraceMs?: number;
  /** Pending permission/question requests per session; more are denied. */
  maxPendingPerSession?: number;
  probeTimeoutMs?: number;
  closeGraceMs?: number;
  /** Bounded in-memory transcript per session. */
  maxTranscriptItems?: number;
  maxTranscripts?: number;
  /** Connection-level event queue; overflow fails the connection (every in-flight run becomes `unknown`). */
  maxQueuedEvents?: number;
}

const nativeSpawn: MsbSpawn = (argv, options) => { assertArchHost(); return Bun.spawn([...argv], options) as unknown as MsbChild; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const MAX_DETAIL = 8 * 1024;
const MAX_ANSWER = 2000;

const ERROR_CLASS: Readonly<Record<ClaudeErrorClass, ProviderErrorClass | null>> = Object.freeze({
  usage_limit: "usage_limit", auth: "auth", overloaded: "overloaded", bad_request: "bad_request", max_turns: null, execution: null,
});

function now(): string { return new Date().toISOString(); }
function preview(input: JsonObject): { detail: string; truncated: boolean } {
  let text: string;
  try { text = JSON.stringify(input, null, 2) ?? "{}"; } catch { text = "{}"; }
  return text.length > MAX_DETAIL ? { detail: text.slice(0, MAX_DETAIL), truncated: true } : { detail: text, truncated: false };
}
function str(value: unknown, max: number): string | null { return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null; }
function toolFiles(input: JsonObject): string[] {
  const path = str(input.file_path, 1024) ?? str(input.notebook_path, 1024);
  return path ? [path] : [];
}
function toolItem(id: string, name: string, input: JsonObject): ActivityItem {
  const base: ActivityItem = { id, kind: "tool", status: "in_progress", text: null, command: null, exitCode: null, files: [], tool: name };
  if (name === "Bash") return { ...base, kind: "command", command: str(input.command, 8 * 1024) };
  if (FILE_TOOLS.has(name)) return { ...base, kind: "file_change", files: toolFiles(input) };
  const hint = str(input.description, 256) ?? str(input.pattern, 256) ?? str(input.url, 512) ?? str(input.path, 512) ?? str(input.file_path, 512) ?? str(input.query, 256);
  return { ...base, text: hint };
}

interface Turn {
  id: string;
  interruptRequested: boolean;
  messageKey: string;
  messageSeq: number;
  texts: Map<string, string>;
  thinkingStarted: Set<string>;
  tools: Map<string, ActivityItem>;
  timer: ReturnType<typeof setTimeout> | undefined;
  killTimer: ReturnType<typeof setTimeout> | undefined;
}
interface PendingRequest { requestId: string; runId: string; kind: "permission" | "question"; input: JsonObject; questions: ClaudeQuestion[] }
interface SessionProcess {
  id: string;
  proc: ClaudeStreamProcess;
  turn: Turn | null;
  pending: Map<string, PendingRequest>;
  lastActivity: number;
  closing: string | null;
  initSeen: boolean;
}
interface Transcript { items: HistoryItem[]; runs: HistoryRun[] }

class EventQueue implements AsyncIterable<ProviderEvent> {
  #values: ProviderEvent[] = [];
  #waiters: Array<{ resolve: (value: IteratorResult<ProviderEvent>) => void; reject: (error: SafeError) => void }> = [];
  #ended = false;
  #error: SafeError | null = null;
  constructor(readonly max: number) {}
  push(value: ProviderEvent): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) { waiter.resolve({ value, done: false }); return; }
    if (this.#values.length >= this.max) { this.fail(new SafeError("provider_event_queue_limit")); return; }
    this.#values.push(value);
  }
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }
  fail(error: SafeError): void {
    if (this.#ended) return;
    this.#ended = true; this.#error = error; this.#values = [];
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
  get ended(): boolean { return this.#ended; }
  [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    return { next: async () => {
      const value = this.#values.shift();
      if (value) return { value, done: false };
      if (this.#error) throw this.#error;
      if (this.#ended) return { value: undefined, done: true };
      return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
    } };
  }
}

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;
  readonly capabilities: ProviderCapabilities = CLAUDE_CAPABILITIES;
  readonly #options: Required<ClaudeAdapterOptions>;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.#options = {
      spawn: options.spawn ?? nativeSpawn, maxSessions: options.maxSessions ?? 4, idleMs: options.idleMs ?? 20 * 60_000,
      maxTurnMs: options.maxTurnMs ?? 2 * 60 * 60_000, turnKillGraceMs: options.turnKillGraceMs ?? 30_000,
      maxPendingPerSession: options.maxPendingPerSession ?? 8, probeTimeoutMs: options.probeTimeoutMs ?? 20_000,
      closeGraceMs: options.closeGraceMs ?? 3000, maxTranscriptItems: options.maxTranscriptItems ?? 500,
      maxTranscripts: options.maxTranscripts ?? 64, maxQueuedEvents: options.maxQueuedEvents ?? 20_000,
    };
    for (const [key, value] of Object.entries(this.#options)) {
      if (key !== "spawn" && !(Number.isSafeInteger(value) && (value as number) > 0)) throw new SafeError("invalid_claude_limits");
    }
  }

  acceptsTarget(vmName: string): boolean {
    try { assertClaudeTarget(vmName); return true; } catch { return false; }
  }

  async probe(): Promise<ProviderCapabilities> { return { ...this.capabilities }; }

  async connect(target: ExecutionTarget): Promise<ProviderConnection> {
    if (target.provider !== "claude" || !validProject(target.projectId) || !target.discoveryVersion) throw new SafeError("provider_target_invalid");
    const identity = vmIdentity(target.vmName);
    if (identity.provider !== "claude" || identity.project !== target.projectId || FORBIDDEN_E2_VMS.includes(target.vmName)) throw new SafeError("provider_target_invalid");
    return new ClaudeConnection(target.vmName, this.#options);
  }
}

class ClaudeConnection implements ProviderConnection {
  readonly #vm: string;
  readonly #o: Required<ClaudeAdapterOptions>;
  readonly #queue: EventQueue;
  readonly #sessions = new Map<string, SessionProcess>();
  readonly #transcripts = new Map<string, Transcript>();
  readonly #finished = new Map<string, ReconciliationResult["status"]>();
  #permissionPrompt: "host" | "tool" | null = null;
  #closed = false;
  #reaper: ReturnType<typeof setInterval> | undefined;
  /** Diagnostics only (counts, never content). */
  readonly stats = { deniedOutsideTurn: 0, deniedOverLimit: 0, unsupportedControl: 0, ignoredFrames: 0 };

  constructor(vm: string, options: Required<ClaudeAdapterOptions>) {
    this.#vm = vm;
    this.#o = options;
    this.#queue = new EventQueue(options.maxQueuedEvents);
  }

  async initialize(): Promise<ProtocolIdentity> {
    if (this.#closed) throw new SafeError("provider_connection_closed");
    if (this.#permissionPrompt) throw new SafeError("provider_already_initialized");
    // Read-only probe inside the VM: version, flag surface and login state. No prompt, no quota, no credential is read.
    const run = (command: string[]) => execClaudeOnce(this.#o.spawn, this.#vm, command, this.#o.probeTimeoutMs)
      .catch(error => { throw new SafeError(error instanceof SafeError && error.code === "claude_command_timeout" ? "provider_probe_timeout" : "provider_probe_failed"); });
    const version = await run(["claude", "--version"]);
    const help = await run(["claude", "--help"]);
    const caps = probeCapabilities(version.stdout, help.stdout);
    if (version.code !== 0 || !caps.version || Number(caps.version.split(".")[0]) < MIN_CLAUDE_MAJOR) throw new SafeError("provider_version_unsupported");
    if (caps.missing.length || !caps.permissionPrompt) throw new SafeError("provider_capability_missing");
    const auth = await run(["claude", "auth", "status", "--json"]);
    let loggedIn = false;
    try {
      const parsed = JSON.parse(auth.stdout) as unknown;
      // Only this boolean survives; e-mail, organisation and any other identity field are dropped here.
      loggedIn = typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).loggedIn === true;
    } catch { throw new SafeError("provider_auth_status_unreadable"); }
    if (!loggedIn) throw new SafeError("provider_auth_required");
    this.#permissionPrompt = caps.permissionPrompt;
    this.#reaper = setInterval(() => this.#reapIdle(), Math.min(60_000, this.#o.idleMs));
    (this.#reaper as { unref?: () => void }).unref?.();
    return { provider: "claude", protocolVersion: CLAUDE_PROTOCOL, serverVersion: caps.version };
  }

  async listSessions(): Promise<{ sessions: ProviderSessionSummary[]; nextCursor: string | null }> {
    this.#ready();
    return { sessions: [], nextCursor: null }; // the stream-json channel cannot enumerate sessions
  }

  async startSession(input: StartSessionInput): Promise<ProviderSessionRef> {
    this.#ready();
    if (input.mode !== "new") throw new SafeError("provider_input_invalid");
    const id = randomUUID();
    await this.#open(id, { sessionId: id });
    return { id };
  }

  async resumeSession(ref: ProviderSessionRef, hints?: ResumeHints): Promise<ProviderSessionRef> {
    this.#ready();
    if (typeof ref.id !== "string" || !UUID.test(ref.id)) throw new SafeError("provider_input_invalid");
    const existing = this.#sessions.get(ref.id);
    if (existing && !existing.closing) return { id: ref.id };
    // A session the Cockpit never ran a turn in has no transcript on the VM: reopen it under the same id instead of --resume.
    await this.#open(ref.id, hints?.hasRuns === false ? { sessionId: ref.id } : { resume: ref.id });
    return { id: ref.id };
  }

  async startRun(input: StartRunInput): Promise<ProviderRunRef> {
    this.#ready();
    const session = this.#live(input.session.id);
    if (session.turn) throw new SafeError("provider_session_busy");
    const message = userMessage(input.prompt); // validates before anything is written
    const turn: Turn = { id: `turn-${randomUUID()}`, interruptRequested: false, messageKey: "m0", messageSeq: 0, texts: new Map(),
      thinkingStarted: new Set(), tools: new Map(), timer: undefined, killTimer: undefined };
    session.turn = turn;
    session.lastActivity = Date.now();
    this.#record(session.id, { id: `${turn.id}:prompt`, kind: "user_message", status: null, text: input.prompt.slice(0, 64 * 1024), command: null, exitCode: null, files: [], runId: turn.id });
    this.#run(session.id, turn.id, "running");
    turn.timer = setTimeout(() => this.#turnTimeout(session, turn), this.#o.maxTurnMs);
    // Written exactly once. A failed write is reported to the caller, which treats the prompt as possibly delivered (unknown).
    await session.proc.send(message);
    return { sessionId: session.id, id: turn.id };
  }

  async interrupt(ref: ProviderRunRef): Promise<void> {
    this.#ready();
    const session = this.#live(ref.sessionId);
    if (!session.turn || session.turn.id !== ref.id) throw new SafeError("provider_run_not_active");
    session.turn.interruptRequested = true;
    await session.proc.send(interruptRequest(`int-${randomUUID()}`));
  }

  async decideApproval(ref: ProviderApprovalRef, input: ApprovalDecision): Promise<void> {
    this.#ready();
    if (input.decision !== "approve" && input.decision !== "reject") throw new SafeError("provider_input_invalid");
    const session = this.#live(ref.sessionId);
    const pending = session.pending.get(String(ref.requestId));
    if (!pending || pending.runId !== ref.runId || session.turn?.id !== ref.runId) throw new SafeError("provider_approval_invalid");
    let frame: JsonObject;
    if (pending.kind === "question") {
      if (input.decision === "reject") {
        if (input.answers !== undefined) throw new SafeError("provider_input_invalid");
        frame = toolDecision(pending.requestId, "deny", undefined, "O operador preferiu não responder pelo Engineering Cockpit.");
      } else frame = toolDecision(pending.requestId, "allow", { ...pending.input, answers: validAnswers(pending.questions, input.answers) });
    } else {
      if (input.answers !== undefined) throw new SafeError("provider_input_invalid");
      // Approve echoes the exact input the operator saw (never a modified one); reject denies.
      frame = input.decision === "approve" ? toolDecision(pending.requestId, "allow", pending.input) : toolDecision(pending.requestId, "deny");
    }
    // Retire before writing: an ambiguous write is never replayed.
    session.pending.delete(pending.requestId);
    session.lastActivity = Date.now();
    await session.proc.send(frame);
  }

  async history(ref: ProviderSessionRef): Promise<HistoryPage> {
    this.#ready();
    const transcript = this.#transcripts.get(ref.id);
    return { items: transcript ? [...transcript.items] : [], runs: transcript ? [...transcript.runs] : [], nextCursor: null };
  }

  async reconcile(ref: ProviderRunRef): Promise<ReconciliationResult> {
    this.#ready();
    const session = this.#sessions.get(ref.sessionId);
    if (session && !session.closing && !session.proc.ended && session.turn?.id === ref.id) return { status: "running", observedAt: now() };
    return { status: this.#finished.get(ref.id) ?? "unknown", observedAt: now() };
  }

  events(): AsyncIterable<ProviderEvent> { this.#ready(); return this.#queue; }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#reaper) clearInterval(this.#reaper);
    await Promise.allSettled([...this.#sessions.values()].map(session => this.#shutdown(session, "connection_closed")));
    this.#queue.end();
  }

  // -------------------------------------------------------------------------------------------------

  #ready(): void {
    if (this.#closed || this.#queue.ended) throw new SafeError("provider_connection_closed");
    if (!this.#permissionPrompt) throw new SafeError("provider_not_initialized");
  }

  #live(sessionId: string): SessionProcess {
    const session = this.#sessions.get(sessionId);
    if (!session || session.closing || session.proc.ended) throw new SafeError("provider_session_not_loaded");
    return session;
  }

  async #open(id: string, mode: { sessionId: string } | { resume: string }): Promise<void> {
    if (this.#sessions.size >= this.#o.maxSessions) {
      // Make room only by closing an idle session (no turn, no pending request); never one that is working.
      const idle = [...this.#sessions.values()].filter(item => !item.turn && item.pending.size === 0 && !item.closing).sort((a, b) => a.lastActivity - b.lastActivity)[0];
      if (!idle) throw new SafeError("provider_session_limit");
      await this.#shutdown(idle, "session_limit_reaped");
    }
    let child: MsbChild;
    try {
      child = this.#o.spawn(claudeStreamArgv(this.#vm, { ...mode, permissionPrompt: this.#permissionPrompt! }),
        { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: minimalChildEnv() });
    } catch (error) { throw error instanceof SafeError && error.code.startsWith("invalid_claude") ? new SafeError("provider_input_invalid") : new SafeError("provider_spawn_failed"); }
    const session: SessionProcess = { id, proc: new ClaudeStreamProcess(child), turn: null, pending: new Map(), lastActivity: Date.now(), closing: null, initSeen: false };
    this.#sessions.set(id, session);
    if (!this.#transcripts.has(id)) {
      if (this.#transcripts.size >= this.#o.maxTranscripts) {
        const oldest = [...this.#transcripts.keys()].find(key => !this.#sessions.has(key));
        if (oldest) this.#transcripts.delete(oldest);
      }
      this.#transcripts.set(id, { items: [], runs: [] });
    }
    void this.#pump(session);
  }

  async #pump(session: SessionProcess): Promise<void> {
    const { proc } = session;
    for (;;) {
      const event = await proc.next(60_000);
      if (!event) { if (proc.ended) break; continue; }
      try { this.#handle(session, event); }
      catch (error) {
        // A frame that breaks session correlation is fatal for this process only.
        await this.#shutdown(session, safeCode(error));
        return;
      }
    }
    this.#ended(session, session.closing ?? (proc.error ? proc.error.code : "claude_process_exited"));
  }

  #handle(session: SessionProcess, event: ClaudeEvent): void {
    session.lastActivity = Date.now();
    const turn = session.turn;
    const emit = (value: ProviderEvent) => this.#queue.push(value);
    const base = { occurredAt: now(), sessionId: session.id };
    switch (event.type) {
      case "init":
        if (event.sessionId !== session.id) throw new SafeError("claude_session_mismatch");
        if (event.permissionMode && event.permissionMode !== "default") throw new SafeError("claude_permission_mode_unexpected");
        session.initSeen = true;
        return;
      case "permission_request":
      case "question": {
        if (!turn) {
          // Nothing of the operator's is running: refuse (fail-closed), never leave it to a default.
          this.stats.deniedOutsideTurn++;
          void session.proc.send(toolDecision(event.requestId, "deny", undefined, "Nenhuma tarefa ativa no Engineering Cockpit.")).catch(() => {});
          return;
        }
        if (session.pending.has(event.requestId)) throw new SafeError("claude_duplicate_request");
        if (session.pending.size >= this.#o.maxPendingPerSession) {
          this.stats.deniedOverLimit++;
          void session.proc.send(toolDecision(event.requestId, "deny", undefined, "Limite de pedidos pendentes no Engineering Cockpit.")).catch(() => {});
          return;
        }
        const itemId = event.toolUseId ? `tool:${event.toolUseId}` : null;
        let summary: ApprovalSummary;
        if (event.type === "question") {
          summary = { actionType: "question", itemId, command: null, cwd: null, reason: null, toolName: "AskUserQuestion",
            questions: event.questions.map(item => ({ question: item.question, header: item.header, multiSelect: item.multiSelect,
              options: item.options.map((label, index) => ({ label, description: item.descriptions[index] ?? null })) })) };
          session.pending.set(event.requestId, { requestId: event.requestId, runId: turn.id, kind: "question", input: event.input, questions: event.questions });
        } else {
          const shown = preview(event.input);
          summary = {
            actionType: event.tool === "Bash" ? "command" : FILE_TOOLS.has(event.tool) ? "file_change" : "tool", itemId,
            command: event.command, cwd: null, reason: str(event.input.description, 2048), toolName: event.tool || "unknown",
            detail: shown.detail, truncated: shown.truncated, files: toolFiles(event.input),
          };
          session.pending.set(event.requestId, { requestId: event.requestId, runId: turn.id, kind: "permission", input: event.input, questions: [] });
        }
        emit({ ...base, type: "approval.requested", runId: turn.id, approval: { sessionId: session.id, runId: turn.id, requestId: event.requestId }, summary });
        return;
      }
      case "control_unsupported":
        this.stats.unsupportedControl++;
        void session.proc.send(controlError(event.requestId)).catch(() => {});
        return;
      case "result": {
        if (!turn) { this.stats.ignoredFrames++; return; }
        this.#endTurn(session, turn);
        // The CLI has no distinct "interrupted" result: a turn the operator (or the time limit) interrupted is reported as such.
        const status = turn.interruptRequested ? "interrupted" : event.ok ? "completed" : "failed";
        if (event.inputTokens !== null || event.outputTokens !== null) {
          emit({ ...base, type: "usage.updated", runId: turn.id, ...(event.inputTokens === null ? {} : { inputTokens: event.inputTokens }),
            ...(event.outputTokens === null ? {} : { outputTokens: event.outputTokens }), ...(event.cachedInputTokens === null ? {} : { cachedInputTokens: event.cachedInputTokens }) });
        }
        const errorClass = event.errorClass ? ERROR_CLASS[event.errorClass] : null;
        this.#run(session.id, turn.id, status);
        emit({ ...base, type: "run.status_changed", runId: turn.id, status, errorMessage: null, errorClass });
        return;
      }
      case "control_ack":
      case "other":
        return;
    }
    // Content frames: attributed only to the Cockpit turn in flight.
    if (!turn) { this.stats.ignoredFrames++; return; }
    switch (event.type) {
      case "message_start":
        turn.messageKey = event.messageId ?? `m${++turn.messageSeq}`;
        return;
      case "delta": {
        if (event.kind === "thinking") {
          const id = `${turn.id}:${turn.messageKey}:thinking`;
          if (!turn.thinkingStarted.has(id)) {
            turn.thinkingStarted.add(id);
            emit({ ...base, type: "run.item", runId: turn.id, phase: "started", item: { id, kind: "reasoning", status: "in_progress", text: null, command: null, exitCode: null, files: [] } });
          }
          return;
        }
        if (event.text) emit({ ...base, type: "run.output_delta", runId: turn.id, itemId: `${turn.id}:${turn.messageKey}:text`, delta: event.text });
        return;
      }
      case "assistant": {
        const key = event.messageId ?? turn.messageKey;
        for (const block of event.blocks) {
          if (block.type === "text") {
            const id = `${turn.id}:${key}:text`;
            const text = ((turn.texts.get(id) ?? "") + block.text).slice(0, 256 * 1024);
            turn.texts.set(id, text);
            const item: ActivityItem = { id, kind: "agent_message", status: "completed", text, command: null, exitCode: null, files: [] };
            this.#record(session.id, { ...item, runId: turn.id });
            emit({ ...base, type: "run.item", runId: turn.id, phase: "completed", item });
          } else if (block.type === "thinking") {
            const item: ActivityItem = { id: `${turn.id}:${key}:thinking`, kind: "reasoning", status: "completed", text: block.text || null, command: null, exitCode: null, files: [] };
            this.#record(session.id, { ...item, runId: turn.id });
            emit({ ...base, type: "run.item", runId: turn.id, phase: "completed", item });
          } else {
            const item = toolItem(`tool:${block.id}`, block.name, block.input);
            if (turn.tools.size < 2000) turn.tools.set(block.id, item);
            this.#record(session.id, { ...item, runId: turn.id });
            emit({ ...base, type: "run.item", runId: turn.id, phase: "started", item });
          }
        }
        return;
      }
      case "user_replay":
        for (const result of event.toolResults) {
          const started = turn.tools.get(result.toolUseId);
          if (!started) continue;
          const item: ActivityItem = { ...started, status: result.isError ? "failed" : "completed",
            text: started.kind === "file_change" ? started.text : result.text || started.text };
          turn.tools.delete(result.toolUseId);
          this.#record(session.id, { ...item, runId: turn.id });
          emit({ ...base, type: "run.item", runId: turn.id, phase: "completed", item });
        }
        return;
    }
  }

  #endTurn(session: SessionProcess, turn: Turn): void {
    if (turn.timer) clearTimeout(turn.timer);
    if (turn.killTimer) clearTimeout(turn.killTimer);
    session.turn = null;
    session.pending.clear(); // requests of a finished turn can never be answered
  }

  #turnTimeout(session: SessionProcess, turn: Turn): void {
    if (session.turn !== turn || session.closing) return;
    turn.interruptRequested = true;
    void session.proc.send(interruptRequest(`int-limit-${randomUUID()}`)).catch(() => {});
    turn.killTimer = setTimeout(() => { if (session.turn === turn) void this.#shutdown(session, "claude_turn_time_limit"); }, this.#o.turnKillGraceMs);
  }

  #reapIdle(): void {
    const cutoff = Date.now() - this.#o.idleMs;
    for (const session of this.#sessions.values()) {
      if (!session.turn && session.pending.size === 0 && !session.closing && session.lastActivity < cutoff) void this.#shutdown(session, "idle_closed");
    }
  }

  async #shutdown(session: SessionProcess, reason: string): Promise<void> {
    if (session.closing) return;
    session.closing = reason;
    // Orderly: close stdin, grace, then SIGKILL. The pump observes the end and reports `session.lost`.
    await session.proc.close(this.#o.closeGraceMs).catch(() => {});
    this.#ended(session, reason);
  }

  #ended(session: SessionProcess, reason: string): void {
    if (this.#sessions.get(session.id) !== session) return;
    this.#sessions.delete(session.id);
    if (session.turn) {
      const turn = session.turn;
      this.#endTurn(session, turn);
      this.#run(session.id, turn.id, "unknown");
    }
    session.pending.clear();
    const code = /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : "claude_process_exited";
    this.#queue.push({ type: "session.lost", occurredAt: now(), sessionId: session.id, runId: null, reason: code });
  }

  #record(sessionId: string, item: HistoryItem): void {
    const transcript = this.#transcripts.get(sessionId);
    if (!transcript) return;
    const index = transcript.items.findIndex(existing => existing.id === item.id);
    if (index >= 0) transcript.items[index] = item; else transcript.items.push(item);
    if (transcript.items.length > this.#o.maxTranscriptItems) transcript.items.splice(0, transcript.items.length - this.#o.maxTranscriptItems);
  }

  #run(sessionId: string, runId: string, status: HistoryRun["status"]): void {
    const transcript = this.#transcripts.get(sessionId);
    if (transcript) {
      const existing = transcript.runs.find(run => run.id === runId);
      if (existing) existing.status = status; else transcript.runs.push({ id: runId, status });
      if (transcript.runs.length > 200) transcript.runs.splice(0, transcript.runs.length - 200);
    }
    if (status !== "running") {
      this.#finished.set(runId, status);
      if (this.#finished.size > 2000) this.#finished.delete(this.#finished.keys().next().value!);
    }
  }
}

/** Every question must be answered, with bounded text; no extra keys. Labels are not forced: AskUserQuestion accepts free text. */
function validAnswers(questions: ClaudeQuestion[], answers: Record<string, string> | undefined): Record<string, string> {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new SafeError("provider_input_invalid");
  const keys = Object.keys(answers);
  const expected = questions.map(item => item.question);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) throw new SafeError("provider_input_invalid");
  const entries = expected.map(key => {
    const value = Object.hasOwn(answers, key) ? answers[key] : undefined;
    if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_ANSWER || value.includes("\0")) throw new SafeError("provider_input_invalid");
    return [key, value] as const;
  });
  return Object.fromEntries(entries); // own properties only, even for a question text like "__proto__"
}

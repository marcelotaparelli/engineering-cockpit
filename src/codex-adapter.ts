import { SafeError, validProject, vmIdentity } from "./model.ts";
import type {
  ActivityItem, ApprovalDecision, ApprovalSummary, ExecutionTarget, HistoryItem, HistoryPage, HistoryRun, ProtocolIdentity, ProviderAdapter, ProviderApprovalRef,
  ProviderCapabilities, ProviderConnection, ProviderErrorClass, ProviderEvent, ProviderRunRef, ProviderSessionRef,
  ProviderSessionSummary, ReconciliationResult, RpcInboundMessage, RpcTransport, StartRunInput,
  StartSessionInput,
} from "./provider.ts";

type TransportFactory = (target: ExecutionTarget) => RpcTransport | Promise<RpcTransport>;
type ObjectValue = Record<string, unknown>;

const DEFAULT_CAPABILITIES: ProviderCapabilities = Object.freeze({
  resume: true,
  interrupt: true,
  approvals: true,
  questions: false,
  sessionListing: "provider",
  history: "paged",
  usage: "session_cumulative",
  reconcile: "provider",
});

// Each version is pinned only after its initialize/thread/list shape was observed (see docs/e0-homologacao.md for 0.166.0).
export const SUPPORTED_CODEX_APP_SERVER_VERSIONS: ReadonlySet<string> = new Set(["0.163.0", "0.164.0", "0.166.0"]);
const CODEX_APP_SERVER_PROTOCOL = "codex-app-server-jsonl-v1";
export const INITIALIZE_FIELDS = Object.freeze(["codexHome", "platformFamily", "platformOs", "userAgent"] as const);
// The originator/version is a complete whitespace-delimited product token.
// Punctuation and Unicode adjacent to it are not accepted as delimiters.
export const USER_AGENT_TOKEN_PATTERN = /(?:^|\s)engineering-cockpit\/(\d+\.\d+\.\d+)(?=\s|$)/g;

// Codex `codexErrorInfo` variants (app-server schema; not yet observed live on 0.166.0). Unknown variants stay unclassified.
const ERROR_CLASS: Readonly<Record<string, ProviderErrorClass>> = Object.freeze({
  usageLimitExceeded: "usage_limit", unauthorized: "auth",
  httpConnectionFailed: "transport", responseStreamConnectionFailed: "transport", responseStreamDisconnected: "transport", responseTooManyFailedAttempts: "transport",
  contextWindowExceeded: "context_window", badRequest: "bad_request", serverOverloaded: "overloaded", sandboxError: "sandbox", internalServerError: "provider_internal",
});
/** `codexErrorInfo` is either a bare variant name or an object keyed by it. */
export function classifyCodexError(error: unknown): ProviderErrorClass | null {
  if (!(typeof error === "object" && error !== null && !Array.isArray(error))) return null;
  const info = (error as Record<string, unknown>).codexErrorInfo;
  const key = typeof info === "string" ? info : typeof info === "object" && info !== null && !Array.isArray(info) && Object.keys(info).length === 1 ? Object.keys(info)[0]! : null;
  return key !== null && Object.hasOwn(ERROR_CLASS, key) ? ERROR_CLASS[key]! : null;
}

function object(value: unknown): value is ObjectValue { return typeof value === "object" && value !== null && !Array.isArray(value); }
function initializeString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new SafeError("provider_initialize_shape_invalid");
  }
  return value;
}
function serverVersion(userAgent: string): string {
  const matches = [...userAgent.matchAll(USER_AGENT_TOKEN_PATTERN)];
  if (matches.length !== 1) throw new SafeError("provider_version_unsupported");
  const version = matches[0]?.[1];
  if (!version || !SUPPORTED_CODEX_APP_SERVER_VERSIONS.has(version)) throw new SafeError("provider_version_unsupported");
  return version;
}
function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new SafeError("provider_response_invalid");
  return value;
}
function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : string(value);
}
// Provider content (messages, commands, deltas) is bounded and only forwarded transiently.
const MAX_TEXT = 256 * 1024;
const MAX_COMMAND = 8 * 1024;
const MAX_FILES = 50;
function boundedText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null;
  return value.length > max ? value.slice(0, max) + "…" : value;
}
function activityStatus(value: unknown): ActivityItem["status"] {
  return value === "inProgress" ? "in_progress" : value === "completed" ? "completed" : value === "failed" ? "failed" : value === "declined" ? "declined" : null;
}
const APPROVAL_POLICY = "on-request";
function activityItem(raw: unknown): ActivityItem | null {
  if (!object(raw) || typeof raw.type !== "string" || typeof raw.id !== "string" || !raw.id || raw.id.length > 512) return null;
  const base: ActivityItem = { id: raw.id, kind: "other", status: null, text: null, command: null, exitCode: null, files: [] };
  switch (raw.type) {
    case "userMessage": {
      const parts = Array.isArray(raw.content) ? raw.content.filter(part => object(part) && part.type === "text" && typeof part.text === "string").map(part => (part as ObjectValue).text as string) : [];
      return { ...base, kind: "user_message", text: boundedText(parts.join("\n")) };
    }
    case "agentMessage": return { ...base, kind: "agent_message", text: boundedText(raw.text) };
    case "plan": return { ...base, kind: "plan", text: boundedText(raw.text) };
    case "reasoning": {
      const summary = Array.isArray(raw.summary) ? raw.summary.filter(part => typeof part === "string").join("\n") : "";
      return { ...base, kind: "reasoning", text: boundedText(summary) || null };
    }
    case "commandExecution":
      return { ...base, kind: "command", status: activityStatus(raw.status), command: boundedText(raw.command, MAX_COMMAND),
        text: boundedText(raw.aggregatedOutput, 16 * 1024),
        exitCode: typeof raw.exitCode === "number" && Number.isSafeInteger(raw.exitCode) ? raw.exitCode : null };
    case "fileChange": {
      const files = Array.isArray(raw.changes) ? raw.changes.flatMap(change => object(change) && typeof change.path === "string" ? [change.path.slice(0, 1024)] : []).slice(0, MAX_FILES) : [];
      return { ...base, kind: "file_change", status: activityStatus(raw.status), files };
    }
    default: return base;
  }
}
function turnStatus(value: unknown): HistoryRun["status"] {
  return value === "inProgress" ? "running" : value === "completed" ? "completed" : value === "failed" ? "failed" : value === "interrupted" ? "interrupted" : "unknown";
}
const SUPPORTED_SERVER_REQUESTS =new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);
function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function threadTimestamp(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000) {
    throw new SafeError("provider_response_invalid");
  }
  return new Date(value * 1000).toISOString();
}
function threadStatus(value: unknown): ProviderSessionSummary["status"] {
  if (!object(value) || typeof value.type !== "string") throw new SafeError("provider_response_invalid");
  if (value.type === "active") {
    if (!Array.isArray(value.activeFlags) || value.activeFlags.length > 2 ||
      value.activeFlags.some(flag => flag !== "waitingOnApproval" && flag !== "waitingOnUserInput") ||
      new Set(value.activeFlags).size !== value.activeFlags.length) {
      throw new SafeError("provider_response_invalid");
    }
    return "active";
  }
  if (Object.hasOwn(value, "activeFlags")) throw new SafeError("provider_response_invalid");
  if (value.type === "idle") return "idle";
  if (value.type === "notLoaded" || value.type === "systemError") return "unknown";
  throw new SafeError("provider_response_invalid");
}
function resultObject(value: unknown): ObjectValue {
  if (!object(value)) throw new SafeError("provider_response_invalid");
  return value;
}
function nested(value: unknown, key: string): ObjectValue {
  const parent = resultObject(value);
  return resultObject(parent[key]);
}
function now(): string { return new Date().toISOString(); }

export class CodexAppServerAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  readonly #capabilities: ProviderCapabilities;

  constructor(readonly transportFactory: TransportFactory, capabilities: ProviderCapabilities = DEFAULT_CAPABILITIES) {
    this.#capabilities = Object.freeze({ ...capabilities });
  }

  get capabilities(): ProviderCapabilities { return { ...this.#capabilities }; }
  async probe(): Promise<ProviderCapabilities> { return { ...this.#capabilities }; }

  async connect(target: ExecutionTarget): Promise<ProviderConnection> {
    if (target.provider !== "codex" || !validProject(target.projectId) || !target.discoveryVersion) throw new SafeError("provider_target_invalid");
    const identity = vmIdentity(target.vmName);
    if (identity.provider !== "codex" || identity.project !== target.projectId) throw new SafeError("provider_target_invalid");
    try { return new CodexConnection(await this.transportFactory(target), this.#capabilities); }
    catch (error) { if (error instanceof SafeError) throw error; throw new SafeError("provider_connect_failed"); }
  }
}

class CodexConnection implements ProviderConnection {
  droppedEvents = 0;
  #initialized = false;
  #closed = false;
  readonly #pendingApprovals = new Map<string, { sessionId: string; runId: string }>();

  constructor(readonly transport: RpcTransport, readonly capabilities: ProviderCapabilities) {}

  async initialize(): Promise<ProtocolIdentity> {
    if (this.#closed) throw new SafeError("provider_connection_closed");
    if (this.#initialized) throw new SafeError("provider_already_initialized");
    const response = await this.#request("initialize", {
      clientInfo: { name: "engineering-cockpit", title: "Engineering Cockpit", version: "m0b.1a" },
      capabilities: {},
    });
    if (!object(response)) throw new SafeError("provider_initialize_shape_invalid");
    const value = response;
    const keys = Object.keys(value);
    if (keys.length !== INITIALIZE_FIELDS.length || keys.some(key => !INITIALIZE_FIELDS.includes(key as typeof INITIALIZE_FIELDS[number]))) {
      throw new SafeError("provider_initialize_shape_invalid");
    }
    const userAgent = initializeString(value.userAgent, 512);
    const codexHome = initializeString(value.codexHome, 4096);
    const platformFamily = initializeString(value.platformFamily, 32);
    const platformOs = initializeString(value.platformOs, 32);
    if (!codexHome.startsWith("/") || codexHome.includes("\0")) throw new SafeError("provider_initialize_home_invalid");
    if (platformFamily !== "unix" || platformOs !== "linux") throw new SafeError("provider_platform_unsupported");
    const observedServerVersion = serverVersion(userAgent);
    await this.#notify("initialized");
    this.#initialized = true;
    return { provider: "codex", protocolVersion: CODEX_APP_SERVER_PROTOCOL, serverVersion: observedServerVersion };
  }

  async listSessions(cursor?: string, limit?: number): Promise<{ sessions: ProviderSessionSummary[]; nextCursor: string | null }> {
    this.#ready();
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) throw new SafeError("provider_input_invalid");
    const response = resultObject(await this.#request("thread/list", { ...(cursor ? { cursor } : {}), ...(limit === undefined ? {} : { limit }) }));
    if (!Array.isArray(response.data)) throw new SafeError("provider_response_invalid");
    const sessions = response.data.map(value => {
      const row = resultObject(value);
      return {
        ref: { id: string(row.id) },
        status: threadStatus(row.status),
        updatedAt: threadTimestamp(row.updatedAt),
      } satisfies ProviderSessionSummary;
    });
    return { sessions, nextCursor: nullableString(response.nextCursor) };
  }

  async startSession(input: StartSessionInput): Promise<ProviderSessionRef> {
    this.#ready();
    if (input.mode !== "new") throw new SafeError("provider_input_invalid");
    const thread = nested(await this.#request("thread/start", { cwd: "/workspace", approvalPolicy: APPROVAL_POLICY }), "thread");
    return { id: string(thread.id) };
  }

  async resumeSession(ref: ProviderSessionRef): Promise<ProviderSessionRef> {
    this.#ready(); this.#require("resume");
    const thread = nested(await this.#request("thread/resume", { threadId: string(ref.id), approvalPolicy: APPROVAL_POLICY }), "thread");
    return { id: string(thread.id) };
  }

  async startRun(input: StartRunInput): Promise<ProviderRunRef> {
    this.#ready();
    if (!input.prompt || input.prompt.length > 1_000_000 || input.prompt.includes("\0")) throw new SafeError("provider_input_invalid");
    const threadId = string(input.session.id);
    const turn = nested(await this.#request("turn/start", { threadId, input: [{ type: "text", text: input.prompt, text_elements: [] }] }), "turn");
    return { sessionId: threadId, id: string(turn.id) };
  }

  async interrupt(ref: ProviderRunRef): Promise<void> {
    this.#ready(); this.#require("interrupt");
    await this.#request("turn/interrupt", { threadId: string(ref.sessionId), turnId: string(ref.id) });
  }

  async decideApproval(ref: ProviderApprovalRef, input: ApprovalDecision): Promise<void> {
    this.#ready(); this.#require("approvals");
    const decision = input.decision;
    if ((decision !== "approve" && decision !== "reject") || input.answers !== undefined) throw new SafeError("provider_input_invalid");
    const sessionId = string(ref.sessionId); const runId = string(ref.runId);
    const key = this.#approvalKey(ref.requestId);
    const pending = this.#pendingApprovals.get(key);
    if (!pending || pending.sessionId !== sessionId || pending.runId !== runId) throw new SafeError("provider_approval_invalid");
    // Retire before writing: a failed/ambiguous write must never be replayed automatically.
    this.#pendingApprovals.delete(key);
    try { await this.transport.respond(ref.requestId, { decision: decision === "approve" ? "accept" : "decline" }); }
    catch (error) { if (error instanceof SafeError) throw error; throw new SafeError("provider_request_failed"); }
  }

  async history(ref: ProviderSessionRef, cursor?: string): Promise<HistoryPage> {
    this.#ready(); this.#require("history");
    const response = resultObject(await this.#request("thread/read", { threadId: string(ref.id), includeTurns: true, ...(cursor ? { cursor } : {}) }));
    const thread = resultObject(response.thread);
    if (!Array.isArray(thread.turns)) throw new SafeError("provider_response_invalid");
    const items: HistoryItem[] = [];
    const runs: HistoryRun[] = [];
    for (const rawTurn of thread.turns.slice(-200)) {
      const turn = resultObject(rawTurn);
      const runId = string(turn.id);
      runs.push({ id: runId, status: turnStatus(turn.status) });
      if (!Array.isArray(turn.items)) continue;
      for (const rawItem of turn.items) {
        const item = activityItem(rawItem);
        if (item && item.kind !== "other") items.push({ ...item, runId });
      }
    }
    return { items: items.slice(-1000), runs, nextCursor: nullableString(response.nextCursor) };
  }

  async reconcile(ref: ProviderRunRef): Promise<ReconciliationResult> {
    this.#ready();
    const response = resultObject(await this.#request("thread/read", { threadId: string(ref.sessionId), includeTurns: true }));
    const thread = resultObject(response.thread);
    if (!Array.isArray(thread.turns)) throw new SafeError("provider_response_invalid");
    const match = thread.turns.find(value => object(value) && value.id === ref.id);
    if (!object(match)) return { status: "unknown", observedAt: now() };
    return { status: turnStatus(match.status), observedAt: now() };
  }

  async *events(): AsyncIterable<ProviderEvent> {
    this.#ready();
    try {
      for await (const message of this.transport.messages()) {
        let event: ProviderEvent | null = null;
        // One malformed or duplicate provider frame must not take down every run on the VM: skip it.
        try { event = this.#mapEvent(message); } catch (error) { if (!(error instanceof SafeError)) throw error; this.droppedEvents++; }
        if (event) yield event;
      }
    } catch (error) { if (error instanceof SafeError) throw error; throw new SafeError("provider_events_failed"); }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#pendingApprovals.clear();
    try { await this.transport.close(); }
    catch (error) { if (error instanceof SafeError) throw error; throw new SafeError("provider_close_failed"); }
  }

  #ready(): void {
    if (this.#closed) throw new SafeError("provider_connection_closed");
    if (!this.#initialized) throw new SafeError("provider_not_initialized");
  }
  #require(capability: "resume" | "interrupt" | "approvals" | "history"): void {
    const supported = capability === "history" ? this.capabilities.history !== "none" : this.capabilities[capability];
    if (!supported) throw new SafeError("provider_capability_unsupported");
  }
  async #request(method: string, params: ObjectValue): Promise<unknown> {
    try { return await this.transport.request(method, params); }
    catch (error) { if (error instanceof SafeError) throw error; throw new SafeError("provider_request_failed"); }
  }
  async #notify(method: string, params?: ObjectValue): Promise<void> {
    try { await this.transport.notify(method, params); }
    catch (error) { if (error instanceof SafeError) throw error; throw new SafeError("provider_request_failed"); }
  }

  #mapEvent(message: RpcInboundMessage): ProviderEvent | null {
    const params = message.params;
    if (message.method === "thread/started") {
      const thread = resultObject(params.thread);
      return { type: "session.connected", occurredAt: now(), sessionId: string(thread.id), runId: null };
    }
    if (message.method === "turn/started" || message.method === "turn/completed") {
      const turn = resultObject(params.turn);
      const base = { occurredAt: now(), sessionId: string(params.threadId), runId: string(turn.id) };
      if (message.method === "turn/started") return { ...base, type: "run.started", status: "running" };
      const status = turnStatus(turn.status);
      const error = object(turn.error) ? boundedText(turn.error.message, 2048) : null;
      return { ...base, type: "run.status_changed", status: status === "running" ? "unknown" : status, errorMessage: error, errorClass: classifyCodexError(turn.error) };
    }
    if (message.method === "item/agentMessage/delta") {
      const delta = boundedText(params.delta, 64 * 1024);
      if (delta === null) return null;
      return { type: "run.output_delta", occurredAt: now(), sessionId: string(params.threadId), runId: string(params.turnId), itemId: string(params.itemId), delta };
    }
    if (message.method === "item/started" || message.method === "item/completed") {
      const item = activityItem(params.item);
      if (!item || item.kind === "other") return null;
      return { type: "run.item", occurredAt: now(), sessionId: string(params.threadId), runId: string(params.turnId),
        phase: message.method === "item/started" ? "started" : "completed", item };
    }
    if (message.method === "error") {
      const error = object(params.error) ? params.error : {};
      return { type: "run.error", occurredAt: now(), sessionId: string(params.threadId), runId: string(params.turnId),
        code: "provider_turn_error", message: boundedText(error.message, 2048), willRetry: params.willRetry === true, errorClass: classifyCodexError(error) };
    }
    if (message.method === "serverRequest/resolved") {
      const requestId = params.requestId;
      if (typeof requestId !== "string" && typeof requestId !== "number") return null;
      this.#pendingApprovals.delete(this.#approvalKey(requestId));
      return { type: "approval.resolved", occurredAt: now(), sessionId: string(params.threadId), runId: null, requestId };
    }
    if (SUPPORTED_SERVER_REQUESTS.has(message.method) && message.requestId !== undefined) {
      const sessionId = string(params.threadId); const runId = string(params.turnId);
      const key = this.#approvalKey(message.requestId);
      if (this.#pendingApprovals.has(key)) throw new SafeError("provider_response_invalid");
      this.#pendingApprovals.set(key, { sessionId, runId });
      const summary: ApprovalSummary = {
        actionType: message.method === "item/fileChange/requestApproval" ? "file_change" : "command",
        itemId: typeof params.itemId === "string" ? params.itemId.slice(0, 512) : null,
        command: boundedText(params.command, MAX_COMMAND),
        cwd: boundedText(params.cwd, 1024),
        reason: boundedText(params.reason, 2048),
      };
      return { type: "approval.requested", occurredAt: now(), sessionId, runId, approval: { sessionId, runId, requestId: message.requestId }, summary };
    }
    if (message.requestId !== undefined) {
      // Server requests we cannot answer safely (user input, permissions, tool calls) block the turn until interrupted.
      const runId = typeof params.turnId === "string" && params.turnId ? params.turnId.slice(0, 512) : null;
      const sessionId = typeof params.threadId === "string" && params.threadId ? params.threadId.slice(0, 512) : "";
      return { type: "request.unsupported", occurredAt: now(), sessionId, runId, method: message.method.slice(0, 128) };
    }
    if (message.method === "thread/tokenUsage/updated") {
      const usage = resultObject(params.tokenUsage);
      const total = object(usage.total) ? usage.total : {};
      const inputTokens = finiteCount(total.inputTokens);
      const outputTokens = finiteCount(total.outputTokens);
      const cachedInputTokens = finiteCount(total.cachedInputTokens);
      return {
        type: "usage.updated", occurredAt: now(), sessionId: string(params.threadId), runId: nullableString(params.turnId),
        ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
      };
    }
    return null;
  }

  #approvalKey(id: string | number): string {
    if (typeof id === "string") return `s:${string(id)}`;
    if (!Number.isSafeInteger(id)) throw new SafeError("provider_response_invalid");
    return `n:${id}`;
  }
}

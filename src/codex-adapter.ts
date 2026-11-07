import { SafeError, validProject, vmIdentity } from "./model.ts";
import type {
  ExecutionTarget, HistoryItem, HistoryPage, ProtocolIdentity, ProviderAdapter, ProviderApprovalRef,
  ProviderCapabilities, ProviderConnection, ProviderEvent, ProviderRunRef, ProviderSessionRef,
  ProviderSessionSummary, ReconciliationResult, RpcInboundMessage, RpcTransport, StartRunInput,
  StartSessionInput,
} from "./provider.ts";

type TransportFactory = (target: ExecutionTarget) => RpcTransport | Promise<RpcTransport>;
type ObjectValue = Record<string, unknown>;

const DEFAULT_CAPABILITIES: ProviderCapabilities = Object.freeze({
  resume: true,
  interrupt: true,
  approvals: true,
  history: "paged",
  usage: "session_cumulative",
});

const SUPPORTED_CODEX_APP_SERVER_VERSIONS = new Set(["0.163.0", "0.164.0"]);
const CODEX_APP_SERVER_PROTOCOL = "codex-app-server-jsonl-v1";
const INITIALIZE_FIELDS = Object.freeze(["codexHome", "platformFamily", "platformOs", "userAgent"] as const);
// The originator/version is a complete whitespace-delimited product token.
// Punctuation and Unicode adjacent to it are not accepted as delimiters.
const USER_AGENT_TOKEN_PATTERN = /(?:^|\s)engineering-cockpit\/(\d+\.\d+\.\d+)(?=\s|$)/g;

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
    const thread = nested(await this.#request("thread/start", { cwd: "/workspace" }), "thread");
    return { id: string(thread.id) };
  }

  async resumeSession(ref: ProviderSessionRef): Promise<ProviderSessionRef> {
    this.#ready(); this.#require("resume");
    const thread = nested(await this.#request("thread/resume", { threadId: string(ref.id) }), "thread");
    return { id: string(thread.id) };
  }

  async startRun(input: StartRunInput): Promise<ProviderRunRef> {
    this.#ready();
    if (!input.prompt || input.prompt.length > 1_000_000 || input.prompt.includes("\0")) throw new SafeError("provider_input_invalid");
    const threadId = string(input.session.id);
    const turn = nested(await this.#request("turn/start", { threadId, input: [{ type: "text", text: input.prompt }] }), "turn");
    return { sessionId: threadId, id: string(turn.id) };
  }

  async interrupt(ref: ProviderRunRef): Promise<void> {
    this.#ready(); this.#require("interrupt");
    await this.#request("turn/interrupt", { threadId: string(ref.sessionId), turnId: string(ref.id) });
  }

  async decideApproval(ref: ProviderApprovalRef, decision: "approve" | "reject"): Promise<void> {
    this.#ready(); this.#require("approvals");
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
    for (const rawTurn of thread.turns) {
      const turn = resultObject(rawTurn);
      if (!Array.isArray(turn.items)) continue;
      for (const rawItem of turn.items) {
        const item = resultObject(rawItem);
        const type = string(item.type);
        if (type !== "message") continue;
        const role = item.role === "user" || item.role === "assistant" || item.role === "system" ? item.role : null;
        items.push({ id: string(item.id), kind: "message", role, text: nullableString(item.text) });
      }
    }
    return { items, nextCursor: nullableString(response.nextCursor) };
  }

  async reconcile(ref: ProviderRunRef): Promise<ReconciliationResult> {
    this.#ready();
    const response = resultObject(await this.#request("thread/read", { threadId: string(ref.sessionId), includeTurns: true }));
    const thread = resultObject(response.thread);
    if (!Array.isArray(thread.turns)) throw new SafeError("provider_response_invalid");
    const match = thread.turns.find(value => object(value) && value.id === ref.id);
    if (!object(match)) return { status: "unknown", observedAt: now() };
    const mapped: Readonly<Record<string, ReconciliationResult["status"]>> = {
      inProgress: "running", completed: "completed", failed: "failed", interrupted: "interrupted",
    };
    const status = typeof match.status === "string" ? mapped[match.status] ?? "unknown" : "unknown";
    return { status, observedAt: now() };
  }

  async *events(): AsyncIterable<ProviderEvent> {
    this.#ready();
    try {
      for await (const message of this.transport.messages()) {
        const event = this.#mapEvent(message);
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
      const terminal: Readonly<Record<string, "completed" | "failed" | "interrupted" | "unknown">> = {
        completed: "completed", failed: "failed", interrupted: "interrupted",
      };
      const status = typeof turn.status === "string" ? terminal[turn.status] ?? "unknown" : "unknown";
      return { ...base, type: "run.status_changed", status };
    }
    if ((message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") && message.requestId !== undefined) {
      const sessionId = string(params.threadId); const runId = string(params.turnId);
      const key = this.#approvalKey(message.requestId);
      if (this.#pendingApprovals.has(key)) throw new SafeError("provider_response_invalid");
      this.#pendingApprovals.set(key, { sessionId, runId });
      return { type: "approval.requested", occurredAt: now(), sessionId, runId, approval: { sessionId, runId, requestId: message.requestId } };
    }
    if (message.method === "thread/tokenUsage/updated") {
      const usage = resultObject(params.tokenUsage);
      const inputTokens = finiteCount(usage.inputTokens);
      const outputTokens = finiteCount(usage.outputTokens);
      return {
        type: "usage.updated", occurredAt: now(), sessionId: string(params.threadId), runId: nullableString(params.turnId),
        ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }),
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

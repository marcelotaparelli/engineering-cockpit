import type { Provider } from "./model.ts";

export type RunStatus =
  | "prepared"
  | "dispatching"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "interrupted"
  | "unknown";

export interface ExecutionTarget {
  provider: Provider;
  projectId: string;
  vmName: string;
  vmInstanceId: string | null;
  discoveryVersion: string;
}

export interface ProviderCapabilities {
  resume: boolean;
  interrupt: boolean;
  approvals: boolean;
  history: "none" | "paged";
  usage: "none" | "session_cumulative" | "run";
}

export interface ProtocolIdentity {
  provider: Provider;
  protocolVersion: string;
  serverVersion: string;
}

export interface ProviderSessionRef { id: string }
export interface ProviderRunRef { sessionId: string; id: string }
export interface ProviderApprovalRef {
  sessionId: string;
  runId: string;
  requestId: string | number;
}

export interface ProviderSessionSummary {
  ref: ProviderSessionRef;
  status: "active" | "idle" | "unknown";
  updatedAt: string | null;
}

export interface StartSessionInput { mode: "new" }
export interface StartRunInput { session: ProviderSessionRef; prompt: string }

export type ActivityKind = "user_message" | "agent_message" | "command" | "file_change" | "reasoning" | "plan" | "other";
export type ActivityStatus = "in_progress" | "completed" | "failed" | "declined" | null;
/** Provider-neutral view of one unit of agent work. Content is transient: never journaled. */
export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  status: ActivityStatus;
  text: string | null;
  command: string | null;
  exitCode: number | null;
  files: string[];
}
export interface HistoryItem extends ActivityItem { runId: string | null }
export interface HistoryRun { id: string; status: Exclude<RunStatus, "prepared" | "dispatching" | "awaiting_approval"> }
export interface HistoryPage { items: HistoryItem[]; runs: HistoryRun[]; nextCursor: string | null }

export interface ApprovalSummary {
  actionType: "command" | "file_change";
  itemId: string | null;
  command: string | null;
  cwd: string | null;
  reason: string | null;
}

export interface ReconciliationResult {
  status: Exclude<RunStatus, "prepared" | "dispatching" | "awaiting_approval">;
  observedAt: string;
}

interface ProviderEventBase {
  occurredAt: string;
  sessionId: string;
}

/** Closed, allowlisted classification of a provider failure. Derived from structured codes only, never from message text. */
export type ProviderErrorClass = "usage_limit" | "auth" | "transport" | "context_window" | "bad_request" | "overloaded" | "sandbox" | "provider_internal";

export type ProviderEvent =
  | (ProviderEventBase & { type: "session.connected" | "session.resumed"; runId: null })
  | (ProviderEventBase & { type: "run.started"; runId: string; status: "running" })
  | (ProviderEventBase & { type: "run.status_changed"; runId: string; status: RunStatus; errorMessage?: string | null; errorClass?: ProviderErrorClass | null })
  | (ProviderEventBase & { type: "run.output_delta"; runId: string; itemId: string; delta: string })
  | (ProviderEventBase & { type: "run.item"; runId: string; phase: "started" | "completed"; item: ActivityItem })
  | (ProviderEventBase & { type: "approval.requested"; runId: string; approval: ProviderApprovalRef; summary: ApprovalSummary })
  | (ProviderEventBase & { type: "approval.resolved"; runId: null; requestId: RpcId })
  | (ProviderEventBase & { type: "usage.updated"; runId: string | null; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number })
  | (ProviderEventBase & { type: "run.error"; runId: string; code: string; message: string | null; willRetry: boolean; errorClass?: ProviderErrorClass | null })
  | (ProviderEventBase & { type: "request.unsupported"; runId: string | null; method: string });

export type RpcId = string | number;
export interface RpcInboundMessage {
  method: string;
  params: Record<string, unknown>;
  requestId?: RpcId;
}

export interface RpcTransport {
  request(method: string, params: Record<string, unknown>, deadlineMs?: number): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  respond(id: RpcId, result: unknown): Promise<void>;
  messages(): AsyncIterable<RpcInboundMessage>;
  close(): Promise<void>;
}

export interface ProviderConnection {
  initialize(): Promise<ProtocolIdentity>;
  listSessions(cursor?: string, limit?: number): Promise<{ sessions: ProviderSessionSummary[]; nextCursor: string | null }>;
  startSession(input: StartSessionInput): Promise<ProviderSessionRef>;
  resumeSession(ref: ProviderSessionRef): Promise<ProviderSessionRef>;
  startRun(input: StartRunInput): Promise<ProviderRunRef>;
  interrupt(ref: ProviderRunRef): Promise<void>;
  decideApproval(ref: ProviderApprovalRef, decision: "approve" | "reject"): Promise<void>;
  history(ref: ProviderSessionRef, cursor?: string): Promise<HistoryPage>;
  reconcile(ref: ProviderRunRef): Promise<ReconciliationResult>;
  events(): AsyncIterable<ProviderEvent>;
  close(): Promise<void>;
}

export interface ProviderAdapter {
  readonly provider: Provider;
  probe(): Promise<ProviderCapabilities>;
  connect(target: ExecutionTarget): Promise<ProviderConnection>;
}

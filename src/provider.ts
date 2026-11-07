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

export interface HistoryItem {
  id: string;
  kind: "message" | "action" | "status";
  role: "user" | "assistant" | "system" | null;
  text: string | null;
}
export interface HistoryPage { items: HistoryItem[]; nextCursor: string | null }

export interface ReconciliationResult {
  status: Exclude<RunStatus, "prepared" | "dispatching" | "awaiting_approval">;
  observedAt: string;
}

interface ProviderEventBase {
  occurredAt: string;
  sessionId: string;
}

export type ProviderEvent =
  | (ProviderEventBase & { type: "session.connected" | "session.resumed"; runId: null })
  | (ProviderEventBase & { type: "run.started"; runId: string; status: "running" })
  | (ProviderEventBase & { type: "run.status_changed"; runId: string; status: RunStatus })
  | (ProviderEventBase & { type: "approval.requested"; runId: string; approval: ProviderApprovalRef })
  | (ProviderEventBase & { type: "usage.updated"; runId: string | null; inputTokens?: number; outputTokens?: number })
  | (ProviderEventBase & { type: "run.error"; runId: string; code: string });

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

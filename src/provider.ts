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
  /** The provider can ask the operator structured questions (answered through the approval channel). */
  questions: boolean;
  /** "provider": the provider enumerates its sessions; "cockpit": only sessions opened through the Cockpit are known. */
  sessionListing: "provider" | "cockpit";
  /** "paged": provider-side transcript; "session_memory": only what this Cockpit process observed (bounded, never persisted). */
  history: "none" | "paged" | "session_memory";
  usage: "none" | "session_cumulative" | "run";
  /** "provider": run state is re-read from the provider; "process": only a live process can confirm a run. */
  reconcile: "provider" | "process";
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
/** `hasRuns`: the Cockpit already bound a provider run to this session (a resumable transcript should exist). */
export interface ResumeHints { hasRuns: boolean }
export interface StartRunInput { session: ProviderSessionRef; prompt: string }

export type ActivityKind = "user_message" | "agent_message" | "command" | "file_change" | "reasoning" | "plan" | "tool" | "other";
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
  /** Provider tool name for `tool` items (e.g. a Claude Code tool). */
  tool?: string | null;
  /**
   * Permission outcome the operator must see: `auto_denied` = the provider refused the tool itself without asking the Cockpit;
   * `unapproved_execution` = a sensitive tool ran without any Cockpit approval (allowed by provider-side configuration).
   */
  notice?: "auto_denied" | "unapproved_execution" | null;
}
export interface HistoryItem extends ActivityItem { runId: string | null }
export interface HistoryRun { id: string; status: Exclude<RunStatus, "prepared" | "dispatching" | "awaiting_approval"> }
export interface HistoryPage { items: HistoryItem[]; runs: HistoryRun[]; nextCursor: string | null }

export type ApprovalActionType = "command" | "file_change" | "tool" | "question";
export interface ApprovalQuestion { question: string; header: string | null; options: Array<{ label: string; description: string | null }>; multiSelect: boolean }
export interface ApprovalSummary {
  actionType: ApprovalActionType;
  itemId: string | null;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  /** Provider tool that asks for permission (when the provider names one). */
  toolName?: string | null;
  /** Bounded, display-only rendering of the exact tool input the operator is approving. */
  detail?: string | null;
  /** True when `detail` had to be cut: the operator did not see the whole input. */
  truncated?: boolean;
  /** Only for `question`: what the agent asks. */
  questions?: ApprovalQuestion[];
  /** Files the action touches, when the provider states them in the request itself. */
  files?: string[];
}
/** Human decision. `answers` (question text → answer) only for `question` approvals with decision "approve". */
export interface ApprovalDecision { decision: "approve" | "reject"; answers?: Record<string, string> }

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
  | (ProviderEventBase & { type: "request.unsupported"; runId: string | null; method: string })
  /** The provider-side session handle died (process exit, limit, idle reap). Any in-flight run becomes `unknown`. */
  | (ProviderEventBase & { type: "session.lost"; runId: null; reason: string });

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
  resumeSession(ref: ProviderSessionRef, hints?: ResumeHints): Promise<ProviderSessionRef>;
  startRun(input: StartRunInput): Promise<ProviderRunRef>;
  interrupt(ref: ProviderRunRef): Promise<void>;
  decideApproval(ref: ProviderApprovalRef, decision: ApprovalDecision): Promise<void>;
  history(ref: ProviderSessionRef, cursor?: string): Promise<HistoryPage>;
  reconcile(ref: ProviderRunRef): Promise<ReconciliationResult>;
  events(): AsyncIterable<ProviderEvent>;
  close(): Promise<void>;
}

export interface ProviderAdapter {
  readonly provider: Provider;
  /** Static capabilities, known before any connection (used for display and routing). */
  readonly capabilities: ProviderCapabilities;
  /** Extra provider-specific refusal of a VM (e.g. a reserved development VM). Defaults to accepting. */
  acceptsTarget?(vmName: string): boolean;
  probe(): Promise<ProviderCapabilities>;
  connect(target: ExecutionTarget): Promise<ProviderConnection>;
}

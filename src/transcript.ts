import { createHash } from "node:crypto";
import type { ActivityItem, ApprovalSummary } from "./provider.ts";

/**
 * E3.1 — what of a conversation the Cockpit keeps on disk, and how.
 *
 * Kept: the operator's prompts, the agent's messages (partial ones marked incomplete), short reasoning, the state of each
 * tool use (tool, command, files, status, exit code, permission notice) and each approval/question (what was asked,
 * what was answered; its status comes from the approvals table).
 * Never kept: tool OUTPUT (file contents, command output, fetched pages can hold anything), stderr, tool inputs other than
 * the command line and file paths, tokens or credentials. Every stored string is bounded and passed through a best-effort
 * secret redaction; nothing here is ever sent back to a provider.
 */
export const TRANSCRIPT_LIMITS = Object.freeze({
  message: 64 * 1024, reasoning: 8 * 1024, command: 4 * 1024, toolHint: 512, path: 512, files: 50, question: 512, answer: 2000, questions: 4,
});
export const REDACTED = "[REDACTED]";

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  [/\b((?:[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|pwd|authorization|credential|cookie)[A-Za-z0-9_-]*)["']?\s*[=:]\s*)(["']?)(?!(?:Bearer|Basic|Token)\s|\[REDACTED\])[^\s"'&;,]{4,}/gi, `$1$2${REDACTED}`],
];

/** Best-effort: known token shapes and `key=value` assignments of secret-looking names. Applied to every persisted string. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const text = value.replaceAll("\0", "");
  return redactSecrets(text.length > max ? text.slice(0, max) : text);
}
function truncated(value: unknown, max: number): boolean { return typeof value === "string" && value.length > max; }

export type TranscriptKind = "user_message" | "agent_message" | "reasoning" | "command" | "file_change" | "tool" | "plan" | "approval" | "other";
export const TRANSCRIPT_KINDS: readonly TranscriptKind[] = ["user_message", "agent_message", "reasoning", "command", "file_change", "tool", "plan", "approval", "other"];
export type TranscriptStatus = "in_progress" | "completed" | "failed" | "declined" | null;

/** The stored, already sanitized body of one transcript row. */
export interface TranscriptBody {
  text?: string | null;
  command?: string | null;
  exitCode?: number | null;
  files?: string[];
  tool?: string | null;
  notice?: "auto_denied" | "unapproved_execution" | null;
  /** The provider produced output for this item that is deliberately not stored. */
  outputOmitted?: boolean;
  /** A stored string was cut to its limit. */
  truncated?: boolean;
  approval?: {
    actionType: ApprovalSummary["actionType"]; toolName: string | null; command: string | null; files: string[];
    questions: string[]; answers: Record<string, string> | null;
  };
}
export interface TranscriptEntry { itemId: string; kind: TranscriptKind; status: TranscriptStatus; complete: boolean; body: TranscriptBody }

const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
/** Provider item ids are used as-is when well-formed, otherwise replaced by a stable hash (deduplication still holds). */
export function transcriptItemId(raw: string): string {
  return ITEM_ID.test(raw) ? raw : `h:${createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 40)}`;
}

function files(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, TRANSCRIPT_LIMITS.files)
    .map(item => clean(item, TRANSCRIPT_LIMITS.path)!);
}

export function userMessageEntry(runId: string, prompt: string): TranscriptEntry {
  return { itemId: transcriptItemId(`${runId}:prompt`), kind: "user_message", status: null, complete: true,
    body: { text: clean(prompt, TRANSCRIPT_LIMITS.message), ...(truncated(prompt, TRANSCRIPT_LIMITS.message) ? { truncated: true } : {}) } };
}

export function partialMessageEntry(itemId: string, text: string): TranscriptEntry {
  return { itemId: transcriptItemId(itemId), kind: "agent_message", status: "in_progress", complete: false,
    body: { text: clean(text, TRANSCRIPT_LIMITS.message), ...(truncated(text, TRANSCRIPT_LIMITS.message) ? { truncated: true } : {}) } };
}

/** Sanitized view of a provider activity item; `null` for items the Cockpit records itself (the user's prompt). */
export function activityEntry(item: ActivityItem, phase: "started" | "completed"): TranscriptEntry | null {
  if (item.kind === "user_message") return null;
  const status: TranscriptStatus = item.status === "in_progress" || item.status === "completed" || item.status === "failed" || item.status === "declined" ? item.status : null;
  const base = { itemId: transcriptItemId(item.id), status, complete: phase === "completed" && status !== "in_progress" };
  const notice = item.notice === "auto_denied" || item.notice === "unapproved_execution" ? item.notice : null;
  switch (item.kind) {
    case "agent_message":
      return { ...base, kind: "agent_message", body: { text: clean(item.text, TRANSCRIPT_LIMITS.message), ...(truncated(item.text, TRANSCRIPT_LIMITS.message) ? { truncated: true } : {}) } };
    case "reasoning": case "plan":
      return { ...base, kind: item.kind, body: { text: clean(item.text, TRANSCRIPT_LIMITS.reasoning), ...(truncated(item.text, TRANSCRIPT_LIMITS.reasoning) ? { truncated: true } : {}) } };
    case "command":
      return { ...base, kind: "command", body: { command: clean(item.command, TRANSCRIPT_LIMITS.command), exitCode: Number.isSafeInteger(item.exitCode) ? item.exitCode : null,
        tool: clean(item.tool, 64), notice, outputOmitted: Boolean(item.text) } };
    case "file_change":
      return { ...base, kind: "file_change", body: { files: files(item.files), tool: clean(item.tool, 64), notice } };
    case "tool":
      // Only the short hint shown while running (pattern, url, path…); the tool's result text is never stored.
      return { ...base, kind: "tool", body: { tool: clean(item.tool, 64), text: phase === "started" ? clean(item.text, TRANSCRIPT_LIMITS.toolHint) : null,
        notice, outputOmitted: phase === "completed" && Boolean(item.text) } };
    default:
      return { ...base, kind: "other", body: {} };
  }
}

export function approvalEntry(approvalId: string, summary: ApprovalSummary & { files: string[] }, answers: Record<string, string> | null = null): TranscriptEntry {
  const questions = (summary.questions ?? []).slice(0, TRANSCRIPT_LIMITS.questions).map(item => clean(item.question, TRANSCRIPT_LIMITS.question) ?? "");
  const kept = answers ? Object.fromEntries(Object.entries(answers).slice(0, TRANSCRIPT_LIMITS.questions)
    .map(([key, value]) => [clean(key, TRANSCRIPT_LIMITS.question) ?? "", clean(value, TRANSCRIPT_LIMITS.answer) ?? ""])) : null;
  return { itemId: transcriptItemId(`approval:${approvalId}`), kind: "approval", status: null, complete: true, body: { approval: {
    actionType: summary.actionType, toolName: clean(summary.toolName, 64), command: clean(summary.command, TRANSCRIPT_LIMITS.command),
    files: files(summary.files), questions, answers: kept } } };
}

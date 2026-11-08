import { SafeError, vmIdentity } from "./model.ts";
import type { JsonObject } from "./jsonl.ts";

/**
 * E2 spike — pure Claude Code `--input-format stream-json --output-format stream-json` protocol layer.
 *
 * Everything here is derived from the documented CLI surface (`claude --help`) and the SDK control protocol as
 * remembered; shapes marked UNVERIFIED must be confirmed by the Arch homologation before E3 relies on them.
 * Nothing here touches processes, files or the network. Raw provider text is never copied into classifications.
 */

export const CLAUDE_VM_PREFIX = "claude-";
/** The development VM; it must never be a spike target. It is also the default of `COCKPIT_RESERVED_VMS` (D8). */
export const FORBIDDEN_E2_VMS: readonly string[] = Object.freeze(["claude-engineering-cockpit"]);
export const DEFAULT_RESERVED_VMS: readonly string[] = FORBIDDEN_E2_VMS;

/** Flags the spike needs. `--permission-prompts` (host) or the legacy `--permission-prompt-tool` must exist: at least one. */
export const REQUIRED_FLAGS = Object.freeze(["--print", "--input-format", "--output-format", "--include-partial-messages", "--resume", "--session-id", "--permission-mode", "--replay-user-messages", "--verbose"] as const);
export const PERMISSION_PROMPT_FLAGS = Object.freeze(["--permission-prompts", "--permission-prompt-tool"] as const);

export interface Capabilities { version: string | null; flags: Record<string, boolean>; missing: string[]; permissionPrompt: "host" | "tool" | null }

/** `claude --version` prints `X.Y.Z (Claude Code)`. Anything else is not trusted. */
export function parseClaudeVersion(text: string): string | null {
  const match = /^(\d+\.\d+\.\d+) \(Claude Code\)\s*$/.exec(text.trim());
  return match ? match[1]! : null;
}

/** Capability probe from `claude --help` text (flag names only; no values are kept). */
export function probeCapabilities(versionText: string, helpText: string): Capabilities {
  const has = (flag: string): boolean => new RegExp(`(^|[\\s,])${flag.replace(/[-]/g, "\\-")}([\\s,<\\[=]|$)`, "m").test(helpText);
  const flags: Record<string, boolean> = {};
  for (const flag of [...REQUIRED_FLAGS, ...PERMISSION_PROMPT_FLAGS, "--no-session-persistence", "--include-hook-events"]) flags[flag] = has(flag);
  const missing: string[] = REQUIRED_FLAGS.filter(flag => !flags[flag]);
  const permissionPrompt = flags["--permission-prompts"] ? "host" : flags["--permission-prompt-tool"] ? "tool" : null;
  if (!permissionPrompt) missing.push("--permission-prompts|--permission-prompt-tool");
  return { version: parseClaudeVersion(versionText), flags, missing, permissionPrompt };
}

/** The host-side `msb exec --stream` argv for a one-shot, non-interactive command in an exclusive Claude VM. */
export function claudeExecArgv(vmName: string, command: readonly string[], reserved: readonly string[] = FORBIDDEN_E2_VMS): readonly string[] {
  assertClaudeTarget(vmName, reserved);
  for (const part of command) if (typeof part !== "string" || part.includes("\0")) throw new SafeError("invalid_claude_argv");
  return Object.freeze(["msb", "exec", "--stream", vmName, "--", ...command]);
}

/** `reserved` defaults to the development VM; the Cockpit passes the configured `COCKPIT_RESERVED_VMS` list. */
export function assertClaudeTarget(vmName: string, reserved: readonly string[] = FORBIDDEN_E2_VMS): void {
  const identity = vmIdentity(vmName);
  if (identity.provider !== "claude") throw new SafeError("e2_target_not_claude");
  if (reserved.includes(vmName)) throw new SafeError("e2_target_forbidden");
}

/** Routes permission prompts (and AskUserQuestion) to the host over stdio as `control_request`/`can_use_tool`. */
export const STDIO_PROMPT_TOOL = Object.freeze(["--permission-prompt-tool", "stdio"] as const);

export interface TurnProcessOptions { sessionId?: string; resume?: string; permissionPrompt: "host" | "tool" }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Long-lived stream-json process: many turns over one stdin, ended by closing stdin.
 * `--permission-mode default` keeps every tool use gated; the human decides through control_request/response.
 * Never `--dangerously-skip-permissions`, never `bypassPermissions`.
 */
export function claudeStreamArgv(vmName: string, options: TurnProcessOptions, reserved: readonly string[] = FORBIDDEN_E2_VMS): readonly string[] {
  if (options.sessionId !== undefined && options.resume !== undefined) throw new SafeError("invalid_claude_argv");
  for (const id of [options.sessionId, options.resume]) if (id !== undefined && !UUID.test(id)) throw new SafeError("invalid_claude_session_id");
  // `--permission-prompts host` only says prompts are not auto-denied; the route to THIS process's stdio is the hidden
  // `--permission-prompt-tool stdio` (what the Agent SDK passes). Without it 2.1.x answers every prompt with a local deny
  // (`system/permission_denied`, `result.permission_denials`) and no `can_use_tool` ever reaches the host — the E2 Arch
  // INCONCLUSIVE outcome. Static reading of the 2.1.319 CLI (same version as the Arch run); still to be confirmed on Arch.
  const prompts = options.permissionPrompt === "host" ? ["--permission-prompts", "host", ...STDIO_PROMPT_TOOL] : [...STDIO_PROMPT_TOOL];
  return claudeExecArgv(vmName, ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--include-partial-messages", "--replay-user-messages", "--permission-mode", "default", ...prompts,
    ...(options.sessionId ? ["--session-id", options.sessionId] : []), ...(options.resume ? ["--resume", options.resume] : [])], reserved);
}

// ------------------------------------------------------------------------------------ outbound (host → claude)
export function userMessage(text: string): JsonObject {
  if (typeof text !== "string" || text.length === 0 || text.length > 64 * 1024 || text.includes("\0")) throw new SafeError("invalid_prompt");
  return { type: "user", message: { role: "user", content: text } };
}
export function interruptRequest(requestId: string): JsonObject {
  return { type: "control_request", request_id: requestId, request: { subtype: "interrupt" } };
}
export function toolDecision(requestId: string, decision: "allow" | "deny", input?: JsonObject, message = "Rejeitado pelo operador no Engineering Cockpit."): JsonObject {
  // UNVERIFIED: `allow` echoes the original `updatedInput`; `deny` carries a message. Never answered automatically.
  const response = decision === "allow" ? { behavior: "allow", updatedInput: input ?? {} } : { behavior: "deny", message };
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response } };
}
/** Fail-closed answer to a control request the Cockpit does not implement: an error, never a permissive success. */
export function controlError(requestId: string, error = "unsupported_by_engineering_cockpit"): JsonObject {
  return { type: "control_response", response: { subtype: "error", request_id: requestId, error } };
}
/** AskUserQuestion is answered through the same permission channel: allow with `answers` keyed by question text. UNVERIFIED. */
export function questionAnswer(requestId: string, questions: unknown, answers: Record<string, string>): JsonObject {
  return toolDecision(requestId, "allow", { questions, answers });
}

// ------------------------------------------------------------------------------------ inbound (claude → host)
export type ClaudeErrorClass = "usage_limit" | "auth" | "overloaded" | "bad_request" | "max_turns" | "execution";
export interface ClaudeQuestion { question: string; header: string | null; options: string[]; descriptions: Array<string | null>; multiSelect: boolean }
export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: JsonObject };
export interface ToolResult { toolUseId: string; isError: boolean; text: string }
export type ClaudeEvent =
  | { type: "init"; sessionId: string; model: string | null; permissionMode: string | null; apiKeySource: string | null }
  | { type: "message_start"; messageId: string | null }
  | { type: "delta"; text: string; kind: "text" | "thinking" }
  | { type: "assistant"; text: string; toolUses: string[]; messageId: string | null; blocks: AssistantBlock[] }
  | { type: "user_replay"; toolResults: ToolResult[] }
  | { type: "permission_request"; requestId: string; tool: string; command: string | null; input: JsonObject; toolUseId: string | null }
  | { type: "question"; requestId: string; questions: ClaudeQuestion[]; raw: unknown; input: JsonObject; toolUseId: string | null }
  | { type: "control_unsupported"; requestId: string; subtype: string }
  /** The CLI denied a tool itself (no host asked). `reasonType` is a structural tag, never message text. */
  | { type: "permission_denied"; toolName: string; toolUseId: string | null; reasonType: string | null }
  | { type: "control_ack"; requestId: string; ok: boolean }
  | { type: "result"; ok: boolean; subtype: string; sessionId: string | null; errorClass: ClaudeErrorClass | null; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; permissionDenials: number }
  | { type: "other"; kind: string };

const bound = (value: unknown, max: number): string => typeof value === "string" ? value.slice(0, max) : "";
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const optionalId = (value: unknown): string | null => typeof value === "string" && ID.test(value) ? value : null;

/** Structured codes only — never message text. HTTP-style status is used when the CLI reports one (UNVERIFIED field name `api_error_status`). */
export function classifyResultError(result: JsonObject): ClaudeErrorClass | null {
  if (result.is_error !== true && result.subtype === "success") return null;
  const status = typeof result.api_error_status === "number" ? result.api_error_status : null;
  if (status === 429) return "usage_limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 529 || status === 503) return "overloaded";
  if (status === 400 || status === 413) return "bad_request";
  if (result.subtype === "error_max_turns") return "max_turns";
  if (result.subtype === "error_during_execution") return "execution";
  return null;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 16 * 1024);
  if (!Array.isArray(content)) return "";
  return content.filter(isObject).map(part => part.type === "text" ? bound(part.text, 16 * 1024) : "").join("\n").slice(0, 16 * 1024);
}

export function parseClaudeEvent(line: JsonObject): ClaudeEvent {
  const type = bound(line.type, 64);
  if (type === "system" && line.subtype === "init") {
    const sessionId = bound(line.session_id, 64);
    if (!UUID.test(sessionId)) throw new SafeError("claude_protocol_invalid");
    return { type: "init", sessionId, model: bound(line.model, 128) || null, permissionMode: bound(line.permissionMode, 32) || null, apiKeySource: bound(line.apiKeySource, 32) || null };
  }
  if (type === "system" && line.subtype === "permission_denied") {
    const reason = bound(line.decision_reason_type, 64);
    return { type: "permission_denied", toolName: bound(line.tool_name, 64) || "unknown", toolUseId: optionalId(line.tool_use_id), reasonType: /^[A-Za-z0-9_-]{1,64}$/.test(reason) ? reason : null };
  }
  if (type === "stream_event" && isObject(line.event)) {
    if (line.event.type === "message_start") return { type: "message_start", messageId: isObject(line.event.message) ? optionalId(line.event.message.id) : null };
    const delta = isObject(line.event.delta) ? line.event.delta : null;
    if (line.event.type === "content_block_delta" && delta?.type === "text_delta") return { type: "delta", kind: "text", text: bound(delta.text, 64 * 1024) };
    if (line.event.type === "content_block_delta" && delta?.type === "thinking_delta") return { type: "delta", kind: "thinking", text: bound(delta.thinking, 64 * 1024) };
    return { type: "other", kind: "stream_event" };
  }
  if (type === "assistant" && isObject(line.message) && Array.isArray(line.message.content)) {
    let text = "";
    const toolUses: string[] = [];
    const blocks: AssistantBlock[] = [];
    for (const block of line.message.content) {
      if (!isObject(block)) continue;
      if (block.type === "text") { const value = bound(block.text, 64 * 1024); text += value; blocks.push({ type: "text", text: value }); }
      if (block.type === "thinking") blocks.push({ type: "thinking", text: bound(block.thinking, 64 * 1024) });
      if (block.type === "tool_use") {
        const name = bound(block.name, 64);
        toolUses.push(name);
        const id = optionalId(block.id);
        if (id) blocks.push({ type: "tool_use", id, name, input: isObject(block.input) ? block.input : {} });
      }
    }
    return { type: "assistant", text, toolUses, messageId: optionalId(line.message.id), blocks };
  }
  if (type === "user") {
    const content = isObject(line.message) ? line.message.content : null;
    const toolResults: ToolResult[] = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isObject(block) || block.type !== "tool_result") continue;
        const toolUseId = optionalId(block.tool_use_id);
        if (toolUseId) toolResults.push({ toolUseId, isError: block.is_error === true, text: toolResultText(block.content) });
      }
    }
    return { type: "user_replay", toolResults };
  }
  if (type === "control_request" && isObject(line.request)) {
    const requestId = bound(line.request_id, 128);
    if (!requestId) throw new SafeError("claude_protocol_invalid");
    if (line.request.subtype !== "can_use_tool") return { type: "control_unsupported", requestId, subtype: bound(line.request.subtype, 64) || "unknown" };
    const tool = bound(line.request.tool_name, 64);
    const input = isObject(line.request.input) ? line.request.input : {};
    const toolUseId = optionalId(line.request.tool_use_id);
    if (tool === "AskUserQuestion" && Array.isArray(input.questions)) {
      const questions = input.questions.filter(isObject).slice(0, 4).map(item => {
        const options = (Array.isArray(item.options) ? item.options : []).filter(isObject).slice(0, 8);
        return { question: bound(item.question, 512), header: bound(item.header, 64) || null, multiSelect: item.multiSelect === true,
          options: options.map(option => bound(option.label, 128)), descriptions: options.map(option => bound(option.description, 512) || null) };
      });
      return { type: "question", requestId, questions, raw: input.questions, input, toolUseId };
    }
    return { type: "permission_request", requestId, tool, command: tool === "Bash" ? bound(input.command, 4096) : null, input, toolUseId };
  }
  if (type === "control_response" && isObject(line.response)) {
    return { type: "control_ack", requestId: bound(line.response.request_id, 128), ok: line.response.subtype === "success" };
  }
  if (type === "result") {
    const usage = isObject(line.usage) ? line.usage : {};
    const ok = line.is_error !== true && line.subtype === "success";
    return { type: "result", ok, subtype: bound(line.subtype, 64), sessionId: UUID.test(bound(line.session_id, 64)) ? bound(line.session_id, 64) : null,
      errorClass: ok ? null : classifyResultError(line), inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens),
      cachedInputTokens: count(usage.cache_read_input_tokens), permissionDenials: Array.isArray(line.permission_denials) ? Math.min(line.permission_denials.length, 1000) : 0 };
  }
  return { type: "other", kind: type || "unknown" };
}

import { describe, expect, test } from "bun:test";
import { assertClaudeTarget, claudeStreamArgv, classifyResultError, interruptRequest, parseClaudeEvent, parseClaudeVersion, probeCapabilities, questionAnswer, toolDecision, userMessage } from "../src/claude-protocol.ts";
import { FAKE_CLAUDE_VERSION } from "../src/fake-claude.ts";

const SID = "123e4567-e89b-42d3-a456-426614174000";

describe("E2 claude protocol (pure)", () => {
  test("version parsing is strict", () => {
    expect(parseClaudeVersion("2.1.319 (Claude Code)\n")).toBe("2.1.319");
    for (const bad of ["", "2.1 (Claude Code)", "v2.1.319", "2.1.319", "2.1.319 (Claude Code) extra", "x\n2.1.319 (Claude Code)"]) expect(parseClaudeVersion(bad)).toBeNull();
  });
  test("capability probe reports missing flags by name only", () => {
    const full = probeCapabilities(`${FAKE_CLAUDE_VERSION} (Claude Code)`, "  -p, --print\n  --input-format <f>\n  --output-format <f>\n  --include-partial-messages\n  --replay-user-messages\n  --verbose\n  -r, --resume [v]\n  --session-id <u>\n  --permission-mode <m>\n  --permission-prompts <t>\n");
    expect(full).toMatchObject({ version: FAKE_CLAUDE_VERSION, missing: [], permissionPrompt: "host" });
    const partial = probeCapabilities("1.0.0 (Claude Code)", "  --print\n  --input-format-extra\n  --permission-prompt-tool <t>\n");
    expect(partial.missing).toContain("--output-format");
    expect(partial.missing).toContain("--input-format"); // a longer flag name must not satisfy a shorter one
    expect(partial.permissionPrompt).toBe("tool");
    expect(probeCapabilities("", "").missing).toContain("--permission-prompts|--permission-prompt-tool");
  });
  test("argv targets only claude VMs, never the dev VM, never bypasses permissions, validates session ids", () => {
    const argv = claudeStreamArgv("claude-cockpit-e2-test", { sessionId: SID, permissionPrompt: "host" });
    expect(argv.slice(0, 6)).toEqual(["msb", "exec", "--stream", "claude-cockpit-e2-test", "--", "claude"]);
    expect(argv).toContain("stream-json");
    expect(argv).toContain("default");
    expect(argv.join(" ")).not.toMatch(/dangerously|bypassPermissions|acceptEdits|--bare/);
    expect(claudeStreamArgv("claude-cockpit-e2-test", { resume: SID, permissionPrompt: "tool" })).toContain("--permission-prompt-tool");
    // E2 Arch regression: `--permission-prompts host` alone never routes prompts to stdio; the hidden stdio route must be present.
    const host = claudeStreamArgv("claude-cockpit-e2-test", { sessionId: SID, permissionPrompt: "host" });
    expect(host[host.indexOf("--permission-prompts") + 1]).toBe("host");
    expect(host[host.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
    expect(() => claudeStreamArgv("codex-cockpit-e2-test", { permissionPrompt: "host" })).toThrow("e2_target_not_claude");
    expect(() => claudeStreamArgv("claude-engineering-cockpit", { permissionPrompt: "host" })).toThrow("e2_target_forbidden");
    expect(() => assertClaudeTarget("claude-bad name")).toThrow("invalid_vm_name");
    expect(() => claudeStreamArgv("claude-cockpit-e2-test", { sessionId: "not-a-uuid", permissionPrompt: "host" })).toThrow("invalid_claude_session_id");
    expect(() => claudeStreamArgv("claude-cockpit-e2-test", { sessionId: SID, resume: SID, permissionPrompt: "host" })).toThrow("invalid_claude_argv");
  });
  test("outbound frames", () => {
    expect(userMessage("oi")).toEqual({ type: "user", message: { role: "user", content: "oi" } });
    expect(() => userMessage("")).toThrow("invalid_prompt");
    expect(() => userMessage("a\0b")).toThrow("invalid_prompt");
    expect(interruptRequest("r1")).toEqual({ type: "control_request", request_id: "r1", request: { subtype: "interrupt" } });
    expect(JSON.stringify(toolDecision("r1", "deny"))).toContain('"behavior":"deny"');
    expect(JSON.stringify(questionAnswer("r2", [], { "A ou B?": "A" }))).toContain('"answers":{"A ou B?":"A"}');
  });
  test("inbound classification: init, deltas, permission, question, result; raw error text never classifies", () => {
    expect(parseClaudeEvent({ type: "system", subtype: "init", session_id: SID, model: "m", permissionMode: "default", apiKeySource: "none" })).toMatchObject({ type: "init", sessionId: SID, permissionMode: "default" });
    expect(() => parseClaudeEvent({ type: "system", subtype: "init", session_id: "x" })).toThrow("claude_protocol_invalid");
    expect(parseClaudeEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ab" } } })).toEqual({ type: "delta", kind: "text", text: "ab" });
    expect(parseClaudeEvent({ type: "control_request", request_id: "q", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } } })).toEqual({ type: "permission_request", requestId: "q", tool: "Bash", command: "ls", input: { command: "ls" }, toolUseId: null });
    const question = parseClaudeEvent({ type: "control_request", request_id: "q2", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "A?", multiSelect: false, options: [{ label: "x" }, { label: "y" }] }] } } });
    expect(question).toMatchObject({ type: "question", requestId: "q2", questions: [{ question: "A?", options: ["x", "y"] }] });
    expect(parseClaudeEvent({ type: "result", subtype: "success", is_error: false, session_id: SID, usage: { input_tokens: 3, output_tokens: 4 } })).toMatchObject({ ok: true, errorClass: null, inputTokens: 3 });
    expect(classifyResultError({ is_error: true, subtype: "success", api_error_status: 429, result: "rate limit exceeded" })).toBe("usage_limit");
    expect(classifyResultError({ is_error: true, subtype: "success", api_error_status: 401 })).toBe("auth");
    expect(classifyResultError({ is_error: true, subtype: "success", api_error_status: 529 })).toBe("overloaded");
    expect(classifyResultError({ is_error: true, subtype: "error_max_turns" })).toBe("max_turns");
    expect(classifyResultError({ is_error: true, subtype: "success", result: "usage limit reached, 429" })).toBeNull(); // text alone is never trusted
    expect(parseClaudeEvent({ type: "rate_limit_event" })).toEqual({ type: "other", kind: "rate_limit_event" });
  });
  test("local permission denials are parsed structurally (tool, id, reason tag) without message text", () => {
    const denied = parseClaudeEvent({ type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "toolu_1", decision_reason_type: "asyncAgent", message: "SEGREDO" });
    expect(denied).toEqual({ type: "permission_denied", toolName: "Bash", toolUseId: "toolu_1", reasonType: "asyncAgent" });
    expect(JSON.stringify(denied)).not.toContain("SEGREDO");
    expect(parseClaudeEvent({ type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "bad id!", decision_reason_type: "x y" }))
      .toMatchObject({ toolUseId: null, reasonType: null });
    expect(parseClaudeEvent({ type: "result", subtype: "success", is_error: false, permission_denials: [{}, {}] })).toMatchObject({ ok: true, permissionDenials: 2 });
    expect(parseClaudeEvent({ type: "result", subtype: "success", is_error: false })).toMatchObject({ permissionDenials: 0 });
  });
});

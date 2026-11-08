import { describe, expect, test } from "bun:test";
import { ClaudeCodeAdapter, CLAUDE_CAPABILITIES, type ClaudeAdapterOptions } from "../src/claude-adapter.ts";
import { fakeClaudeSpawn, newFakeWorld, type FakeClaudeWorld } from "../src/fake-claude.ts";
import type { ExecutionTarget, ProviderConnection, ProviderEvent } from "../src/provider.ts";

/** Contract tests of the Claude Code adapter against the in-process fake CLI. Nothing is spawned; no network, no quota. */
const target: ExecutionTarget = { provider: "claude", projectId: "demo", vmName: "claude-demo", vmInstanceId: null, discoveryVersion: "2026-11-07T00:00:00Z" };

async function connect(world: FakeClaudeWorld = newFakeWorld(), options: ClaudeAdapterOptions = {}) {
  const adapter = new ClaudeCodeAdapter({ spawn: fakeClaudeSpawn(world), closeGraceMs: 100, ...options });
  const connection = await adapter.connect(target);
  const identity = await connection.initialize();
  const events: ProviderEvent[] = [];
  let failure: unknown = null;
  void (async () => { try { for await (const event of connection.events()) events.push(event); } catch (error) { failure = error; } })();
  return { world, adapter, connection, identity, events, failure: () => failure };
}
async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) { if (Date.now() > deadline) throw new Error("timeout"); await Bun.sleep(5); }
}
const ofType = <T extends ProviderEvent["type"]>(events: ProviderEvent[], type: T) => events.filter((event): event is Extract<ProviderEvent, { type: T }> => event.type === type);
const finished = (events: ProviderEvent[], runId: string) => ofType(events, "run.status_changed").find(event => event.runId === runId);
const streams = (world: FakeClaudeWorld) => world.spawned.filter(item => item.argv.includes("stream-json"));

describe("Claude Code adapter: connection and process boundary", () => {
  test("refuses non-Claude, mismatched and reserved targets before spawning anything", async () => {
    const world = newFakeWorld();
    const adapter = new ClaudeCodeAdapter({ spawn: fakeClaudeSpawn(world) });
    await expect(adapter.connect({ ...target, provider: "codex" })).rejects.toThrow("provider_target_invalid");
    await expect(adapter.connect({ ...target, vmName: "claude-other" })).rejects.toThrow("provider_target_invalid");
    await expect(adapter.connect({ ...target, vmName: "codex-demo" })).rejects.toThrow("provider_target_invalid");
    await expect(adapter.connect({ ...target, projectId: "engineering-cockpit", vmName: "claude-engineering-cockpit" })).rejects.toThrow("provider_target_invalid");
    expect(adapter.acceptsTarget("claude-engineering-cockpit")).toBe(false);
    expect(adapter.acceptsTarget("claude-demo")).toBe(true);
    expect(world.spawned).toHaveLength(0);
    expect(adapter.capabilities).toEqual(CLAUDE_CAPABILITIES);
  });

  test("initialize is read-only (version, help, auth status), drops identity fields and refuses unsafe CLIs", async () => {
    const { world, identity, connection } = await connect();
    expect(identity).toEqual({ provider: "claude", protocolVersion: "claude-code-stream-json-v1", serverVersion: "2.1.319" });
    expect(world.spawned.map(item => item.argv.slice(5).join(" "))).toEqual(["claude --version", "claude --help", "claude auth status --json"]);
    expect(JSON.stringify(identity)).not.toContain("private@example.invalid");
    await connection.close();
    for (const [mutate, code] of [
      [(w: FakeClaudeWorld) => { w.authLoggedIn = false; }, "provider_auth_required"],
      [(w: FakeClaudeWorld) => { w.version = "1.9.0"; }, "provider_version_unsupported"],
      [(w: FakeClaudeWorld) => { w.omitFlags = ["--permission-prompts"]; }, "provider_capability_missing"],
      [(w: FakeClaudeWorld) => { w.omitFlags = ["--resume"]; }, "provider_capability_missing"],
    ] as const) {
      const bad = newFakeWorld(); mutate(bad);
      const connection = await new ClaudeCodeAdapter({ spawn: fakeClaudeSpawn(bad) }).connect(target);
      await expect(connection.initialize()).rejects.toThrow(code);
      expect(streams(bad)).toHaveLength(0);
    }
  });

  test("a new session is one gated stream-json process: --session-id, permission-mode default, host prompts, no bypass, minimal env", async () => {
    const world = newFakeWorld();
    const env: Array<Record<string, string>> = [];
    const spawn = fakeClaudeSpawn(world);
    const { connection } = await connect(world, { spawn: (argv, options) => { env.push(options.env); return spawn(argv, options); } });
    const session = await connection.startSession({ mode: "new" });
    const argv = streams(world)[0]!.argv;
    expect(argv.slice(0, 5)).toEqual(["msb", "exec", "--stream", "claude-demo", "--"]);
    expect(argv).toContain("--session-id"); expect(argv[argv.indexOf("--session-id") + 1]).toBe(session.id);
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("default");
    expect(argv[argv.indexOf("--permission-prompts") + 1]).toBe("host");
    expect(argv.join(" ")).not.toMatch(/dangerously|bypassPermissions|acceptEdits/);
    for (const item of env) expect(Object.keys(item).every(key => ["PATH", "LANG", "LC_ALL"].includes(key))).toBe(true);
    await connection.close();
    expect(world.spawned.every(item => item.ended)).toBe(true);
    expect(streams(world)[0]!.closedByStdin).toBe(true);
  });
});

describe("Claude Code adapter: turns", () => {
  test("prompt written exactly once; deltas, final message, per-run usage, completed; transcript kept in memory", async () => {
    const { world, connection, events } = await connect();
    const session = await connection.startSession({ mode: "new" });
    const run = await connection.startRun({ session, prompt: "diga oi" });
    expect(run.sessionId).toBe(session.id);
    await until(() => Boolean(finished(events, run.id)));
    expect(streams(world)[0]!.prompts).toEqual(["diga oi"]);
    const deltas = ofType(events, "run.output_delta").filter(event => event.runId === run.id);
    expect(deltas.length).toBeGreaterThan(2);
    const message = ofType(events, "run.item").find(event => event.item.kind === "agent_message")!;
    expect(message.item.id).toBe(deltas[0]!.itemId); // the final message replaces the streamed one
    expect(deltas.map(event => event.delta).join("")).toBe(message.item.text!);
    expect(ofType(events, "usage.updated")[0]).toMatchObject({ runId: run.id, inputTokens: 10, outputTokens: 5 });
    expect(finished(events, run.id)).toMatchObject({ status: "completed", errorClass: null });
    const history = await connection.history(session);
    expect(history.items.map(item => item.kind)).toEqual(["user_message", "agent_message"]);
    expect(history.runs).toEqual([{ id: run.id, status: "completed" }]);
    expect(await connection.reconcile(run)).toMatchObject({ status: "completed" });
    // Same process, second turn: context kept, no second spawn.
    const second = await connection.startRun({ session, prompt: "remember KIWI" });
    await until(() => Boolean(finished(events, second.id)));
    expect(streams(world)).toHaveLength(1);
    await connection.close();
  });

  test("Bash approval: the human sees command and full input; approve echoes the exact input once; refs are correlated", async () => {
    const { world, connection, events } = await connect();
    const session = await connection.startSession({ mode: "new" });
    const run = await connection.startRun({ session, prompt: "approve this" });
    await until(() => ofType(events, "approval.requested").length === 1);
    const request = ofType(events, "approval.requested")[0]!;
    expect(request.runId).toBe(run.id);
    expect(request.summary).toMatchObject({ actionType: "command", toolName: "Bash", command: "touch /tmp/e2-approval-probe", reason: "probe", truncated: false });
    expect(request.summary.detail).toContain("e2-approval-probe");
    const tool = ofType(events, "run.item").find(event => event.item.kind === "command")!;
    expect(request.summary.itemId).toBe(tool.item.id);
    await expect(connection.decideApproval({ ...request.approval, runId: "turn-other" }, { decision: "approve" })).rejects.toThrow("provider_approval_invalid");
    await expect(connection.decideApproval({ ...request.approval, sessionId: "00000000-0000-4000-8000-000000000000" }, { decision: "approve" })).rejects.toThrow("provider_session_not_loaded");
    await expect(connection.decideApproval(request.approval, { decision: "approve", answers: { a: "b" } })).rejects.toThrow("provider_input_invalid");
    await connection.decideApproval(request.approval, { decision: "approve" });
    await expect(connection.decideApproval(request.approval, { decision: "approve" })).rejects.toThrow("provider_approval_invalid");
    await until(() => Boolean(finished(events, run.id)));
    const proc = streams(world)[0]!;
    expect(proc.allowedInputs).toEqual([{ command: "touch /tmp/e2-approval-probe", description: "probe" }]);
    expect(proc.decisions).toEqual(["allow"]);
    expect(ofType(events, "run.item").filter(event => event.item.id === tool.item.id).at(-1)!.item.status).toBe("completed");
    await connection.close();
  });

  test("file edits and generic tools are classified (file_change / tool) and rejection is a deny", async () => {
    const { world, connection, events } = await connect();
    const session = await connection.startSession({ mode: "new" });
    const edit = await connection.startRun({ session, prompt: "edit the notes" });
    await until(() => ofType(events, "approval.requested").length === 1);
    const first = ofType(events, "approval.requested")[0]!;
    expect(first.summary).toMatchObject({ actionType: "file_change", toolName: "Write", files: ["/workspace/notes.md"] });
    expect(first.summary.detail).toContain("linha nova");
    await connection.decideApproval(first.approval, { decision: "reject" });
    await until(() => Boolean(finished(events, edit.id)));
    const fetch = await connection.startRun({ session, prompt: "fetch the doc" });
    await until(() => ofType(events, "approval.requested").length === 2);
    const second = ofType(events, "approval.requested")[1]!;
    expect(second.summary).toMatchObject({ actionType: "tool", toolName: "WebFetch", command: null });
    expect(second.runId).toBe(fetch.id);
    await connection.decideApproval(second.approval, { decision: "reject" });
    await until(() => Boolean(finished(events, fetch.id)));
    expect(streams(world)[0]!.decisions).toEqual(["deny", "deny"]);
    expect(streams(world)[0]!.allowedInputs).toEqual([]);
    await connection.close();
  });

  test("AskUserQuestion: every question must be answered; the answer goes back with the original input", async () => {
    const { world, connection, events } = await connect();
    const session = await connection.startSession({ mode: "new" });
    const run = await connection.startRun({ session, prompt: "ask me" });
    await until(() => ofType(events, "approval.requested").length === 1);
    const question = ofType(events, "approval.requested")[0]!;
    expect(question.summary).toMatchObject({ actionType: "question", questions: [{ question: "A ou B?", header: "Escolha", multiSelect: false,
      options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] });
    for (const answers of [undefined, {}, { "outra?": "A" }, { "A ou B?": "" }, { "A ou B?": "A", extra: "x" }]) {
      await expect(connection.decideApproval(question.approval, { decision: "approve", ...(answers === undefined ? {} : { answers }) })).rejects.toThrow("provider_input_invalid");
    }
    await connection.decideApproval(question.approval, { decision: "approve", answers: { "A ou B?": "B" } });
    await until(() => Boolean(finished(events, run.id)));
    const sent = streams(world)[0]!.allowedInputs[0]!;
    expect(sent.answers).toEqual({ "A ou B?": "B" });
    expect(Array.isArray(sent.questions)).toBe(true);
    await connection.close();
  });

  test("interrupt ends only the current turn as interrupted; the process stays usable", async () => {
    const { world, connection, events } = await connect();
    const session = await connection.startSession({ mode: "new" });
    const run = await connection.startRun({ session, prompt: "slow essay" });
    await until(() => ofType(events, "run.output_delta").length > 3);
    await expect(connection.interrupt({ sessionId: session.id, id: "turn-other" })).rejects.toThrow("provider_run_not_active");
    await connection.interrupt(run);
    await until(() => Boolean(finished(events, run.id)));
    expect(finished(events, run.id)!.status).toBe("interrupted");
    expect(streams(world)[0]!.interrupts).toBe(1);
    const next = await connection.startRun({ session, prompt: "oi" });
    await until(() => Boolean(finished(events, next.id)));
    expect(finished(events, next.id)!.status).toBe("completed");
    await connection.close();
  });

  test("usage limit and errors are classified from structured codes only", async () => {
    const { connection, events } = await connect();
    const session = await connection.startSession({ mode: "new" });
    const run = await connection.startRun({ session, prompt: "quota" });
    await until(() => Boolean(finished(events, run.id)));
    expect(finished(events, run.id)).toMatchObject({ status: "failed", errorClass: "usage_limit", errorMessage: null });
    expect(JSON.stringify(events)).not.toContain("CANARIO-E2 secret");
    await connection.close();
  });

  test("thinking is surfaced as reasoning items", async () => {
    const { connection, events } = await connect();
    const session = await connection.startSession({ mode: "new" });
    const run = await connection.startRun({ session, prompt: "think hard" });
    await until(() => Boolean(finished(events, run.id)));
    const reasoning = ofType(events, "run.item").filter(event => event.item.kind === "reasoning");
    expect(reasoning.map(event => event.phase)).toEqual(["started", "completed"]);
    expect(reasoning[1]!.item.text).toBe("pensando no problema");
    await connection.close();
  });
});

describe("Claude Code adapter: fail-closed protocol handling and recovery", () => {
  test("an unknown control request gets an error (never success) and the turn continues", async () => {
    const { world, connection, events } = await connect();
    const session = await connection.startSession({ mode: "new" });
    const run = await connection.startRun({ session, prompt: "hook please" });
    await until(() => Boolean(finished(events, run.id)));
    expect(streams(world)[0]!.controlErrors).toEqual(["error"]);
    expect(ofType(events, "approval.requested")).toHaveLength(0);
    expect(finished(events, run.id)!.status).toBe("completed");
    await connection.close();
  });

  test("a permission request outside any Cockpit turn is denied and never surfaced as an approval", async () => {
    const { world, connection, events } = await connect();
    const session = await connection.startSession({ mode: "new" });
    const run = await connection.startRun({ session, prompt: "stray" });
    await until(() => streams(world)[0]!.strayDecisions.length === 1);
    expect(streams(world)[0]!.strayDecisions).toEqual(["deny"]);
    expect(finished(events, run.id)!.status).toBe("completed");
    expect(ofType(events, "approval.requested")).toHaveLength(0);
    await connection.close();
  });

  test("a process that dies mid-turn yields session.lost; the turn is only ever unknown, never replayed", async () => {
    const { world, connection, events } = await connect();
    const session = await connection.startSession({ mode: "new" });
    const run = await connection.startRun({ session, prompt: "crash now" });
    await until(() => ofType(events, "session.lost").length === 1);
    expect(ofType(events, "session.lost")[0]).toMatchObject({ sessionId: session.id, reason: "claude_process_exited" });
    expect(finished(events, run.id)).toBeUndefined();
    expect(await connection.reconcile(run)).toMatchObject({ status: "unknown" });
    await expect(connection.startRun({ session, prompt: "oi" })).rejects.toThrow("provider_session_not_loaded");
    expect(streams(world)[0]!.prompts).toEqual(["crash now"]);
    await connection.close();
  });

  test("a CLI that reports a non-default permission mode is shut down before any content is trusted", async () => {
    const world = newFakeWorld(); world.permissionMode = "bypassPermissions";
    const { connection, events } = await connect(world);
    const session = await connection.startSession({ mode: "new" });
    await connection.startRun({ session, prompt: "oi" });
    await until(() => ofType(events, "session.lost").length === 1);
    expect(ofType(events, "session.lost")[0]!.reason).toBe("claude_permission_mode_unexpected");
    expect(ofType(events, "run.output_delta")).toHaveLength(0);
    await connection.close();
  });

  test("resume hints: never-run sessions reopen by --session-id, sessions with runs by --resume", async () => {
    const world = newFakeWorld();
    const { connection } = await connect(world);
    const fresh = "11111111-1111-4111-8111-111111111111";
    await connection.resumeSession({ id: fresh }, { hasRuns: false });
    expect(streams(world)[0]!.argv).toContain("--session-id");
    world.persisted.add("22222222-2222-4222-8222-222222222222");
    await connection.resumeSession({ id: "22222222-2222-4222-8222-222222222222" }, { hasRuns: true });
    expect(streams(world)[1]!.argv).toContain("--resume");
    await expect(connection.resumeSession({ id: "../etc" })).rejects.toThrow("provider_input_invalid");
    await connection.close();
  });

  test("session limit: an idle process is reaped to make room; a working one never is", async () => {
    const { world, connection, events } = await connect(newFakeWorld(), { maxSessions: 1 });
    const first = await connection.startSession({ mode: "new" });
    const second = await connection.startSession({ mode: "new" });
    expect(ofType(events, "session.lost")).toEqual([expect.objectContaining({ sessionId: first.id, reason: "session_limit_reaped" })]);
    await connection.startRun({ session: second, prompt: "slow" });
    await expect(connection.startSession({ mode: "new" })).rejects.toThrow("provider_session_limit");
    expect(streams(world)).toHaveLength(2);
    await connection.close();
    expect(world.spawned.every(item => item.ended)).toBe(true);
  });

  test("turn time limit: interrupt first, then the process is killed if the turn does not end", async () => {
    const world = newFakeWorld();
    const { connection, events } = await connect(world, { maxTurnMs: 30, turnKillGraceMs: 30 });
    const session = await connection.startSession({ mode: "new" });
    const run = await connection.startRun({ session, prompt: "approve and wait" });
    // Waiting on a human decision does not end the turn on interrupt in the fake: the kill path is exercised.
    await until(() => ofType(events, "session.lost").length === 1 || Boolean(finished(events, run.id)));
    expect(streams(world)[0]!.interrupts).toBe(1);
    const lost = ofType(events, "session.lost")[0];
    const done = finished(events, run.id);
    expect(lost?.reason === "claude_turn_time_limit" || done?.status === "interrupted").toBe(true);
    await connection.close();
  });

  test("idle sessions are closed by the reaper and reported, without touching working ones", async () => {
    const { world, connection, events } = await connect(newFakeWorld(), { idleMs: 20 });
    const session = await connection.startSession({ mode: "new" });
    await until(() => ofType(events, "session.lost").length === 1, 2000);
    expect(ofType(events, "session.lost")[0]).toMatchObject({ sessionId: session.id, reason: "idle_closed" });
    expect(streams(world)[0]!.closedByStdin).toBe(true);
    await connection.close();
  });
});

/** The E2 Arch argv: `--permission-prompts host` without the stdio route (what produced the INCONCLUSIVE approval/question). */
const withoutStdioRoute = (spawn: ReturnType<typeof fakeClaudeSpawn>): ReturnType<typeof fakeClaudeSpawn> => (argv, options) => {
  const index = argv.indexOf("--permission-prompt-tool");
  return spawn(index >= 0 ? [...argv.slice(0, index), ...argv.slice(index + 2)] : argv, options);
};

describe("Claude Code adapter: permission routing (E2 Arch INCONCLUSIVE regression)", () => {
  test("the session argv routes prompts to the host over stdio, so Bash and AskUserQuestion reach the operator", async () => {
    const { world, connection, events } = await connect();
    const session = await connection.startSession({ mode: "new" });
    const argv = streams(world)[0]!.argv;
    expect(argv[argv.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
    const run = await connection.startRun({ session, prompt: "approve this" });
    await until(() => ofType(events, "approval.requested").length === 1);
    await connection.decideApproval(ofType(events, "approval.requested")[0]!.approval, { decision: "reject" });
    await until(() => Boolean(finished(events, run.id)));
    const ask = await connection.startRun({ session, prompt: "ask me" });
    await until(() => ofType(events, "approval.requested").length === 2);
    expect(ofType(events, "approval.requested")[1]!.summary.actionType).toBe("question");
    await connection.interrupt(ask);
    await until(() => Boolean(finished(events, ask.id)));
    expect(streams(world)[0]!.autoDenied).toEqual([]);
    // The operator's own deny is reported back by the CLI too: it must not be mistaken for an automatic one.
    expect(ofType(events, "run.item").some(event => event.item.notice === "auto_denied")).toBe(false);
    await connection.close();
  });

  test("without the stdio route the CLI denies locally: no approval, the tool item is flagged auto_denied, nothing is approved", async () => {
    const world = newFakeWorld();
    const { connection, events, adapter } = await connect(world, { spawn: withoutStdioRoute(fakeClaudeSpawn(world)) });
    const session = await connection.startSession({ mode: "new" });
    const run = await connection.startRun({ session, prompt: "approve this" });
    await until(() => Boolean(finished(events, run.id)));
    expect(ofType(events, "approval.requested")).toEqual([]);
    expect(streams(world)[0]!.autoDenied).toEqual(["Bash"]);
    const flagged = ofType(events, "run.item").filter(event => event.item.notice === "auto_denied");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.item).toMatchObject({ kind: "command", status: "declined", command: "touch /tmp/e2-approval-probe" });
    expect(JSON.stringify(events)).not.toContain("CANARIO-E2"); // the CLI's deny message is never copied
    // A later tool_result must not downgrade the flag back to a plain failure.
    const history = await connection.history(session);
    expect(history.items.find(item => item.id === flagged[0]!.item.id)).toMatchObject({ status: "declined", notice: "auto_denied" });
    expect(adapter).toBeDefined();
    await connection.close();
  });

  test("a sensitive tool that runs without any Cockpit approval (VM allow rule) is flagged unapproved_execution", async () => {
    const world = newFakeWorld();
    world.autoAllow = ["Bash"];
    const { connection, events } = await connect(world);
    const session = await connection.startSession({ mode: "new" });
    const run = await connection.startRun({ session, prompt: "approve this" });
    await until(() => Boolean(finished(events, run.id)));
    expect(ofType(events, "approval.requested")).toEqual([]);
    const done = ofType(events, "run.item").filter(event => event.item.kind === "command" && event.phase === "completed");
    expect(done.at(-1)!.item).toMatchObject({ status: "completed", notice: "unapproved_execution" });
    await connection.close();
  });
});

import { describe, expect, test } from "bun:test";
import { runClaudeSpike, type SpikeOverrides } from "../src/e2-claude-spike.ts";
import { ClaudeStreamProcess } from "../src/claude-process.ts";
import { fakeClaudeSpawn, newFakeWorld, type FakeClaudeWorld } from "../src/fake-claude.ts";
import { claudeStreamArgv, interruptRequest, toolDecision, userMessage } from "../src/claude-protocol.ts";

const VM = "claude-cockpit-e2-test";
const listing = (name = VM, state = "Running") => JSON.stringify([{ name, status: state, image: "x", created_at: "2026-10-25T13:54:12.860454803+00:00" }]);
const baseEnv = { COCKPIT_MODE: "host", COCKPIT_HOST_CONFIRMED: "yes", COCKPIT_E2_CONFIRMED: "yes", COCKPIT_E2_VM: VM };
const arch = { platform: "linux", osRelease: "ID=arch\n", knownGuest: false };
function overrides(world: FakeClaudeWorld, env: Record<string, string | undefined> = {}, extra: Partial<SpikeOverrides> = {}): SpikeOverrides {
  return { facts: arch, env: { ...baseEnv, ...env }, readOutput: async () => listing(), spawn: fakeClaudeSpawn(world), turnTimeoutMs: 4000, graceMs: 200, ...extra };
}
const status = (report: Awaited<ReturnType<typeof runClaudeSpike>>, id: string) => report.checks.find(check => check.id === id)!;

describe("E2 spike runner against the fake Claude CLI (no quota, no real process)", () => {
  test("read-only stage without the prompt consent spawns only version/help/auth and never a stream session", async () => {
    const world = newFakeWorld();
    const report = await runClaudeSpike(overrides(world));
    expect(report.overall).toBe("NOT_VERIFIED");
    expect(report.claude_version).toBe("2.1.319");
    for (const id of ["version", "capabilities", "auth_state"]) expect(status(report, id).status).toBe("PASS");
    expect(status(report, "streaming_turn")).toMatchObject({ status: "NOT_VERIFIED", reason: "prompts_not_authorized" });
    expect(world.spawned.some(item => item.argv.includes("stream-json"))).toBe(false);
    const json = JSON.stringify(report);
    expect(json).not.toContain("private@example.invalid"); // identity fields from `auth status` are dropped
    expect(json).not.toContain("ORG-SECRET");
  });

  test("full real-prompt stage: streaming, same-process turns, interrupt, deny, answer, clean exit, resume", async () => {
    const world = newFakeWorld();
    const report = await runClaudeSpike(overrides(world, { COCKPIT_E2_REAL_PROMPTS: "yes" }));
    const failed = report.checks.filter(check => check.status === "FAIL");
    expect(failed).toEqual([]);
    for (const id of ["streaming_turn", "multi_turn_same_process", "interrupt", "approval_reject", "question_answer", "process_exit", "resume"]) expect(status(report, id).status).toBe("PASS");
    expect(status(report, "streaming_turn").evidence).toMatchObject({ incremental: true, session_id_matches: true, permission_mode: "default" });
    expect(status(report, "interrupt").evidence).toMatchObject({ interrupt_sent: true, turn_ended: true, process_alive: true });
    expect(status(report, "process_exit").evidence).toMatchObject({ exited: true, killed: false });
    expect(status(report, "error_classification").status).toBe("NOT_VERIFIED");
    expect(report.overall).toBe("PASS");
    const streams = world.spawned.filter(item => item.argv.includes("stream-json"));
    expect(streams).toHaveLength(2);
    expect(streams[1]!.argv).toContain("--resume");
    expect(streams.flatMap(item => item.decisions).sort()).toEqual(["answered", "deny"]); // nothing was ever approved
    expect(streams.every(item => item.ended)).toBe(true);
    const json = JSON.stringify(report);
    expect(json).not.toContain("CANARIO-E2"); // no response or stderr content in the report
    expect(json).not.toContain("ABACATE");
    expect(json).not.toContain("approval-probe");
  });

  test("a process that ignores stdin close is killed and the check fails, never left running", async () => {
    const world = newFakeWorld(); world.hangOnClose = true;
    const report = await runClaudeSpike(overrides(world, { COCKPIT_E2_REAL_PROMPTS: "yes" }));
    expect(status(report, "process_exit")).toMatchObject({ status: "FAIL", reason: "needed_sigkill" });
    expect(report.overall).toBe("FAIL");
    expect(world.spawned.every(item => item.ended)).toBe(true);
  });

  test("missing capability fails by flag name and no prompt is sent", async () => {
    const world = newFakeWorld(); world.omitFlags = ["--resume", "--include-partial-messages"];
    const report = await runClaudeSpike(overrides(world, { COCKPIT_E2_REAL_PROMPTS: "yes" }));
    expect(status(report, "capabilities")).toMatchObject({ status: "FAIL", evidence: { missing: "--include-partial-messages,--resume" } });
    expect(world.spawned.some(item => item.argv.includes("stream-json"))).toBe(false);
  });

  test("logged-out auth fails before any prompt", async () => {
    const world = newFakeWorld(); world.authLoggedIn = false;
    const report = await runClaudeSpike(overrides(world, { COCKPIT_E2_REAL_PROMPTS: "yes" }));
    expect(status(report, "auth_state")).toMatchObject({ status: "FAIL", reason: "not_logged_in" });
    expect(world.spawned.some(item => item.argv.includes("stream-json"))).toBe(false);
  });

  test.each([
    [{ COCKPIT_E2_CONFIRMED: undefined }, "e2_confirmation_required"],
    [{ COCKPIT_HOST_CONFIRMED: undefined }, "host_confirmation_required"],
    [{ COCKPIT_E2_VM: undefined }, "e2_target_required"],
    [{ COCKPIT_E2_VM: "claude-engineering-cockpit" }, "e2_target_forbidden"],
    [{ COCKPIT_E2_VM: "codex-cockpit-e2-test" }, "e2_target_not_claude"],
    [{ COCKPIT_E2_VM: "claude-other-project" }, "e2_target_not_isolated"],
  ])("refuses without touching anything: %j", async (env, reason) => {
    const world = newFakeWorld();
    let listed = false;
    const report = await runClaudeSpike(overrides(world, { ...env, COCKPIT_E2_REAL_PROMPTS: "yes" }, { readOutput: async () => { listed = true; return listing(); } }));
    expect(status(report, "host_consent")).toMatchObject({ status: "NOT_VERIFIED", reason });
    expect(world.spawned).toHaveLength(0);
    expect(listed).toBe(false);
  });

  test("non-Arch host, absent and stopped target are NOT_VERIFIED without spawning", async () => {
    const world = newFakeWorld();
    expect(status(await runClaudeSpike(overrides(world, {}, { facts: { platform: "linux", osRelease: "ID=debian\n", knownGuest: false } })), "host_consent").reason).toBe("arch_host_required");
    expect(status(await runClaudeSpike(overrides(world, {}, { readOutput: async () => listing("claude-someone-else") })), "target_running").reason).toBe("e2_target_absent");
    expect(status(await runClaudeSpike(overrides(world, {}, { readOutput: async () => listing(VM, "Stopped") })), "target_running").reason).toBe("e2_target_not_running");
    expect(world.spawned).toHaveLength(0);
  });
});

describe("ClaudeStreamProcess against the fake CLI", () => {
  const open = (world: FakeClaudeWorld, extra: { resume?: string; sessionId?: string } = {}) => new ClaudeStreamProcess(fakeClaudeSpawn(world)(claudeStreamArgv(VM, { permissionPrompt: "host", ...extra }), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} }));

  test("quota exhaustion is a classified failed result; stderr content is drained but never surfaced", async () => {
    const world = newFakeWorld();
    const proc = open(world);
    await proc.send(userMessage("quota please"));
    const { events, matched } = await proc.collect(event => event.type === "result", 2000);
    expect(matched).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "result", ok: false, errorClass: "usage_limit" });
    expect(JSON.stringify(events)).not.toContain("CANARIO-E2");
    expect((await proc.close(200)).killed).toBe(false);
  });

  test("a permission request is never auto-answered: the turn waits for an explicit decision", async () => {
    const world = newFakeWorld();
    const proc = open(world);
    await proc.send(userMessage("approve it"));
    const request = (await proc.collect(event => event.type === "permission_request", 2000)).events.at(-1);
    expect(request).toMatchObject({ type: "permission_request", tool: "Bash" });
    expect(await proc.next(100)).toBeNull(); // silence until the human answers
    await proc.send(toolDecision((request as { requestId: string }).requestId, "deny"));
    expect((await proc.collect(event => event.type === "result", 2000)).matched).toBe(true);
    expect(world.spawned[0]!.decisions).toEqual(["deny"]);
    await proc.close(200);
  });

  test("interrupt during a blocked permission request ends the turn and the process stays usable", async () => {
    const world = newFakeWorld();
    const proc = open(world);
    await proc.send(userMessage("approve it"));
    await proc.collect(event => event.type === "permission_request", 2000);
    await proc.send(interruptRequest("int-1"));
    expect((await proc.collect(event => event.type === "result", 2000)).matched).toBe(true);
    expect(proc.ended).toBe(false);
    await proc.send(userMessage("hello"));
    expect((await proc.collect(event => event.type === "result", 2000)).matched).toBe(true);
    await proc.close(200);
  });

  test("a crashed child ends the stream instead of hanging, and writes then fail safely", async () => {
    const world = newFakeWorld();
    const proc = open(world);
    await proc.send(userMessage("slow please"));
    await proc.next(500);
    const report = await proc.close(50);
    expect(proc.ended).toBe(true);
    expect(report.exited).toBe(true);
    await expect(proc.send(userMessage("again"))).rejects.toThrow("claude_process_ended");
  });
});

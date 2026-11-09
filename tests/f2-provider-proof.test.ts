import { afterAll, afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROOF_PROBE_PROMPT, PROOF_PROMPT, runSystemdSmoke, SMOKE_CHECK_IDS, SMOKE_CLAUDE_PROOF_CHECK_IDS, SMOKE_PROOF_CHECK_IDS, type SmokeReport } from "../src/f1-systemd-smoke.ts";
import { CLAUDE_PROOF_PROMPT } from "../src/f2-proof.ts";
import { bareRoot, fakeBun } from "./support/runtime.ts";
import { alive, FakeSystemd, killSleepers, PARTIAL_TAIL, spawnSleeper, type World } from "./support/fake-systemd.ts";

/**
 * F2-M2 — the provider proof END TO END without systemd, msb or a provider (see support/fake-systemd.ts): the Claude VM mode and
 * the F2 additions to the Codex proof, against a stand-in Cockpit that can be made to misbehave in exactly the ways the proof must
 * catch. What is proven: the sequence works against the API shapes it will meet; every verdict branch; that nothing is signalled
 * outside the smoke unit's own cgroup and that no orphan is ended before the block and the reconcile were checked; that nothing but
 * lengths, counts, booleans and closed codes reaches the report; that everything the smoke created is gone afterwards.
 * What is NOT proven here: that a real `msb` child survives a real SIGKILL under systemd, what the real Claude/Codex stream or answer
 * (only the operator's run can say), and that the real Cockpit's answers match the stand-in's (tests/f2-proof-contract.test.ts holds
 * the parsers to the real server).
 */
setDefaultTimeout(60_000); // each smoke takes ~2.5 s (restart waits, settle time); some tests run several
const work = await mkdtemp(join(tmpdir(), "cockpit-f2-proof-"));
afterAll(async () => { killSleepers(); await rm(work, { recursive: true, force: true }); });
const bin = join(work, "bin");
await fakeBun(bin);
await writeFile(join(bin, "msb"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
let counter = 0;
const signalled: number[] = [];
let killSpy: ReturnType<typeof spyOn> | null = null;
afterEach(() => { killSpy?.mockRestore(); killSpy = null; signalled.length = 0; });

interface Options { survivors?: boolean; provider?: "codex" | "claude"; world?: Partial<World>; proof?: boolean; quota?: boolean; env?: Record<string, string>;
  timeoutsMs?: { start: number; restart: number; settle: number } }
async function smoke(options: Options = {}): Promise<{ report: SmokeReport; fake: FakeSystemd; xdg: string; root: string }> {
  const provider = options.provider ?? "claude";
  const fake = new FakeSystemd(options.survivors ?? true, options.world ?? {}, provider);
  const xdg = join(work, `run-${++counter}`);
  await mkdir(xdg, { mode: 0o700 });
  fake.xdg = xdg;
  const root = await bareRoot(join(work, `root-${counter}`), "none"); // never the real checkout
  const env = { COCKPIT_F1_SMOKE_CONFIRMED: "yes", COCKPIT_SMOKE_VM: fake.world.vm, COCKPIT_PROJECTS_BASE: "/srv/projects", XDG_RUNTIME_DIR: xdg, PATH: bin,
    ...(options.proof === false ? {} : { COCKPIT_SMOKE_ORPHAN_PROOF: "yes", COCKPIT_SMOKE_QUOTA_CONFIRMED: "yes" }), ...(options.env ?? {}) };
  // Records every signal the SMOKE sends (the stand-in signals through Subprocess handles, which do not pass here), in order with the requests.
  const original = process.kill.bind(process);
  killSpy = spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    if (signal !== 0 && signal !== undefined) { signalled.push(pid); fake.world.timeline.push(`kill:${pid}:${String(signal)}`); }
    return original(pid, signal as never);
  }) as typeof process.kill);
  const report = await runSystemdSmoke({ env, run: fake.run, proc: fake.proc, root, timeoutsMs: options.timeoutsMs ?? { start: 5000, restart: 8000, settle: 150 }, onInterrupt: () => () => {} });
  return { report, fake, xdg, root };
}
const status = (report: SmokeReport) => Object.fromEntries(report.checks.map(check => [check.id, check.status]));
const check = (report: SmokeReport, id: string) => report.checks.find(item => item.id === id)!;
const allPass = (ids: readonly string[]) => Object.fromEntries(ids.map(id => [id, "PASS" as const]));
/** Which checks are not PASS, with their reasons: makes a red run readable instead of a bare "expected PASS". */
const failing = (report: SmokeReport) => report.checks.filter(item => item.status !== "PASS").map(item => `${item.id}:${item.status}:${item.reason}`);

describe.skipIf(process.platform !== "linux")("F2-M2 Claude proof, end to end", () => {
  test("a surviving claude_session: every check passes, one real prompt, partial preserved, send refused without a run, conservative reconcile, release", async () => {
    const { report, fake } = await smoke();
    expect(report.provider).toBe("claude");
    expect(report.checks.map(item => item.id)).toEqual([...SMOKE_CHECK_IDS, ...SMOKE_CLAUDE_PROOF_CHECK_IDS]);
    expect(status(report)).toEqual(allPass([...SMOKE_CHECK_IDS, ...SMOKE_CLAUDE_PROOF_CHECK_IDS]));
    expect(report.overall).toBe("PASS");
    expect(fake.world.prompts).toEqual([CLAUDE_PROOF_PROMPT]); // exactly one real prompt; the probe was refused
    expect(fake.world.runsInSession).toBe(1);
    expect(check(report, "orphan_turn_started").evidence).toMatchObject({ provider: "claude", provider_bound: true, partial_text_persisted_before_kill: true });
    expect(check(report, "partial_preserved").evidence).toMatchObject({ prefix_preserved: true, marked_incomplete: true, user_messages: 1 });
    expect(check(report, "orphan_ledger").evidence).toMatchObject({ surviving_msb_children: 1, kinds: { claude_session: 1 } });
    expect(check(report, "orphan_blocks_send").evidence).toEqual({ status: 409, error_code: "orphan_process_alive", runs_in_session: 1 });
    expect(check(report, "reconcile_conservative").evidence).toMatchObject({ run_status: "unknown", result: "unconfirmed", reason_code: "provider_cannot_confirm", new_msb_exec_children: 0 });
    expect(check(report, "reconcile_after_release").evidence).toMatchObject({ run_status: "unknown", reason_code: "provider_cannot_confirm", orphan_existed: true });
  });

  test("order and reach of the signals: the block and the reconcile are checked BEFORE the orphan is ended, only the orphan is signalled, a bystander and a transient `msb list` are not", async () => {
    const bystander = Bun.spawn(["sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const transientList = spawnSleeper(); // an `msb list` of discovery, alive in the unit's cgroup when the Cockpit dies
    try {
      const { report, fake } = await smoke({ world: { listPid: transientList } });
      expect(failing(report)).toEqual([]); // `msb list` is not an orphan: the ledger tracks only `msb exec` children
      expect(report.overall).toBe("PASS");
      const t = fake.world.timeline;
      const probe = t.map((entry, index) => entry === "POST /api/sessions/ses-proof/runs" ? index : -1).filter(index => index >= 0);
      const reconciles = t.map((entry, index) => entry === "POST /api/runs/run-proof/reconcile" ? index : -1).filter(index => index >= 0);
      const end = t.findIndex(entry => entry.startsWith(`kill:${fake.world.orphanPid}:SIGTERM`));
      expect(probe).toHaveLength(2); // the real prompt, then the refused probe
      expect(reconciles).toHaveLength(2); // while the orphan lived, and after it ended
      expect(end).toBeGreaterThan(-1);
      expect(probe[1]!).toBeLessThan(reconciles[0]!);
      expect(reconciles[0]!).toBeLessThan(end); // released only after the safe checks
      expect(end).toBeLessThan(reconciles[1]!);
      expect([...new Set(signalled)]).toEqual([fake.world.orphanPid!]); // nobody else, ever
      expect(signalled).not.toContain(transientList);
      expect(signalled).not.toContain(bystander.pid);
      expect(alive(bystander.pid)).toBe(true);
    } finally { bystander.kill("SIGKILL"); await bystander.exited; }
  });

  test("no surviving child: partial and reconcile are still verified for Claude; the orphan checks are NOT_VERIFIED, never PASS", async () => {
    const { report, fake } = await smoke({ survivors: false });
    expect(status(report)).toMatchObject({ orphan_turn_started: "PASS", crash_restart: "PASS", run_unknown_after_crash: "PASS", partial_preserved: "PASS", reconcile_conservative: "PASS",
      orphan_ledger: "NOT_VERIFIED", orphan_blocks_send: "NOT_VERIFIED", orphan_released: "NOT_VERIFIED", reconcile_after_release: "PASS", cleanup: "PASS" });
    expect(report.overall).toBe("NOT_VERIFIED");
    expect(check(report, "orphan_blocks_send").reason).toBe("no_surviving_msb_child");
    expect(fake.world.prompts).toEqual([CLAUDE_PROOF_PROMPT]);
    expect(signalled).toEqual([]); // the smoke signalled nothing: there was nothing of its own to end
  });

  test("a survivor that is only a one-shot claude command blocks nothing: the ledger lists it, the send block is NOT_VERIFIED, no probe prompt is sent", async () => {
    const { report, fake } = await smoke({ world: { orphanKind: "claude_command" } });
    expect(status(report)).toMatchObject({ orphan_ledger: "PASS", orphan_blocks_send: "NOT_VERIFIED", reconcile_conservative: "PASS", orphan_released: "PASS" });
    expect(check(report, "orphan_blocks_send").reason).toBe("no_blocking_orphan_for_proof_session");
    expect(fake.world.prompts).toEqual([CLAUDE_PROOF_PROMPT]);
    expect(report.overall).toBe("NOT_VERIFIED");
  });

  test("the model never streams enough persisted text: the turn is still killed and partial_preserved is NOT_VERIFIED, not guessed", async () => {
    const { report } = await smoke({ world: { partial: "none" }, timeoutsMs: { start: 1500, restart: 8000, settle: 150 } });
    expect(check(report, "orphan_turn_started")).toMatchObject({ status: "PASS", evidence: { partial_text_persisted_before_kill: false } });
    expect(check(report, "partial_preserved")).toMatchObject({ status: "NOT_VERIFIED", reason: "no_partial_text_before_kill" });
    expect(status(report)).toMatchObject({ crash_restart: "PASS", orphan_blocks_send: "PASS", reconcile_conservative: "PASS", cleanup: "PASS" });
    expect(report.overall).toBe("NOT_VERIFIED");
  });

  const broken: Array<[World["afterCrash"], string]> = [
    ["shortened", "partial_text_changed_after_restart"],
    ["changed", "partial_text_changed_after_restart"],
    ["not_incomplete", "partial_not_marked_incomplete"],
    ["missing", "partial_item_missing_after_restart"],
    ["duplicated_prompt", "prompt_not_exactly_once"],
  ];
  for (const [afterCrash, reason] of broken) {
    test(`a restarted Cockpit that ${afterCrash.replaceAll("_", " ")} the partial answer is a FAIL (${reason}), and the other checks still run`, async () => {
      const { report } = await smoke({ world: { afterCrash } });
      expect(check(report, "partial_preserved")).toMatchObject({ status: "FAIL", reason });
      expect(status(report)).toMatchObject({ orphan_blocks_send: "PASS", reconcile_conservative: "PASS", orphan_released: "PASS", cleanup: "PASS" }); // quota already spent: keep the evidence
      expect(report.overall).toBe("FAIL");
    });
  }

  test("a send refused with 409 that nevertheless created a run is a FAIL", async () => {
    const { report } = await smoke({ world: { blockedSendCreatesRun: true } });
    expect(check(report, "orphan_blocks_send")).toMatchObject({ status: "FAIL", reason: "blocked_send_created_a_run", evidence: { status: 409, runs_in_session: 2 } });
    expect(report.overall).toBe("FAIL");
  });

  test("a send accepted while the orphan lives is a FAIL, and the harmless probe is the only extra prompt", async () => {
    const { report, fake } = await smoke({ world: { blockSends: false } });
    expect(check(report, "orphan_blocks_send").reason).toMatch(/^send_not_blocked_202/);
    expect(fake.world.prompts).toEqual([CLAUDE_PROOF_PROMPT, PROOF_PROBE_PROMPT]);
    expect(report.overall).toBe("FAIL");
  });

  test("a Claude run resolved by a reconcile (without provider evidence) is a FAIL in both phases: D3 is the whole point", async () => {
    const { report } = await smoke({ world: { claudeReconcileResolves: true } });
    expect(check(report, "reconcile_conservative")).toMatchObject({ status: "FAIL", reason: "reconcile_not_conservative" });
    expect(check(report, "reconcile_after_release")).toMatchObject({ status: "FAIL", reason: "claude_run_resolved_without_evidence" });
    expect(report.overall).toBe("FAIL");
  });

  test("a reconcile that opens an `msb exec` child while the owner lives is a FAIL even if its answer looks right", async () => {
    const { report } = await smoke({ world: { reconcileSpawnsExec: true } });
    expect(check(report, "reconcile_conservative")).toMatchObject({ status: "FAIL", reason: "reconcile_spawned_msb_exec_child", evidence: { new_msb_exec_children: 1, reason_code: "provider_cannot_confirm" } });
    expect(report.overall).toBe("FAIL");
  });

  test("the report holds lengths, counts, booleans and closed codes: no prompt, no model text, no credential", async () => {
    const { report, fake } = await smoke();
    const text = JSON.stringify(report);
    for (const secret of [CLAUDE_PROOF_PROMPT, PROOF_PROBE_PROMPT, "linha sobre o mar", PARTIAL_TAIL.trim(), fake.world.agentText.slice(0, 20)]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/token|credential"|cookie|csrf/i);
  });

  test("everything the smoke created is gone: no unit file, no work directory, nothing left in the cgroup", async () => {
    const { fake, xdg, root } = await smoke();
    expect(await readdir(join(xdg, "systemd/user"))).toEqual([]);
    expect(fake.cgroupPids()).toEqual([]);
    expect(await readdir(join(root, ".cache", "f1-systemd-smoke"))).toEqual([]);
  });

  test("preconditions: Claude proof needs the quota confirmation; the development VM is refused; nothing is created", async () => {
    const noQuota = await smoke({ env: { COCKPIT_SMOKE_QUOTA_CONFIRMED: "" } });
    expect(noQuota.report.checks[0]).toMatchObject({ id: "preconditions", status: "NOT_VERIFIED", reason: "quota_confirmation_required" });
    const dev = await smoke({ env: { COCKPIT_SMOKE_VM: "claude-engineering-cockpit" } });
    expect(dev.report.checks[0]).toMatchObject({ status: "NOT_VERIFIED", reason: "smoke_vm_reserved" });
    for (const run of [noQuota, dev]) {
      expect(run.fake.calls.filter(argv => ["start", "daemon-reload", "kill", "stop"].includes(argv[2] ?? ""))).toEqual([]);
      expect(await readdir(run.xdg)).toEqual([]);
      expect(run.fake.world.prompts).toEqual([]);
    }
  });

  test("without the proof, a Claude VM runs the base smoke only and sends no prompt", async () => {
    const { report, fake } = await smoke({ proof: false, survivors: false });
    expect(report.checks.map(item => item.id)).toEqual([...SMOKE_CHECK_IDS]);
    expect(fake.world.prompts).toEqual([]);
    expect(fake.world.sessions).toBe(0);
  });
});

describe.skipIf(process.platform !== "linux")("F2-M2 Codex proof additions (the real check of F2-M1 under systemd)", () => {
  test("a surviving app-server: the reconcile is refused with orphan_owns_turn, opens nothing, and is asked again after the release", async () => {
    const { report, fake } = await smoke({ provider: "codex" });
    expect(report.checks.map(item => item.id)).toEqual([...SMOKE_CHECK_IDS, ...SMOKE_PROOF_CHECK_IDS]);
    expect(status(report)).toEqual(allPass([...SMOKE_CHECK_IDS, ...SMOKE_PROOF_CHECK_IDS]));
    expect(fake.world.prompts).toEqual([PROOF_PROMPT]);
    expect(check(report, "reconcile_conservative").evidence).toMatchObject({ reason_code: "orphan_owns_turn", new_msb_exec_children: 0 });
    expect(check(report, "reconcile_after_release").evidence).toMatchObject({ run_status: "completed", result: "confirmed", orphan_existed: true });
  });

  test("the pre-F2 behaviour (reattaching a running turn while the app-server lives) is caught as a FAIL by the proof", async () => {
    const { report } = await smoke({ provider: "codex", world: { codexOwnerAliveReconcile: "reattach" } });
    expect(check(report, "reconcile_conservative")).toMatchObject({ status: "FAIL", reason: "reconcile_not_conservative", evidence: { run_status: "running", reason_code: "reconciled" } });
    expect(report.overall).toBe("FAIL");
  });

  test("after the release the real provider's answer is OBSERVED: a terminal status or an unconfirmed unknown passes; a turn still running is NOT_VERIFIED (open L4, question P3); still owned is a FAIL", async () => {
    const terminal = await smoke({ provider: "codex", world: { postRelease: "completed" } });
    expect(failing(terminal.report)).toEqual([]);
    const unknown = await smoke({ provider: "codex", world: { postRelease: "unknown" } });
    expect(check(unknown.report, "reconcile_after_release")).toMatchObject({ status: "PASS", evidence: { reason_code: "provider_reports_unknown" } });
    const running = await smoke({ provider: "codex", world: { postRelease: "running" } });
    expect(check(running.report, "reconcile_after_release")).toMatchObject({ status: "NOT_VERIFIED", reason: "reattached_running_after_owner_ended" });
    expect(running.report.overall).toBe("NOT_VERIFIED");
    const owned = await smoke({ provider: "codex", world: { postRelease: "still_owned" } });
    expect(check(owned.report, "reconcile_after_release")).toMatchObject({ status: "FAIL", reason: "orphan_still_owns_turn_after_release" });
  });

  test("no surviving app-server: the owner-alive reconcile is NOT_VERIFIED (it exists only because of an orphan) but the provider's answer is still observed", async () => {
    const { report } = await smoke({ provider: "codex", survivors: false });
    expect(check(report, "reconcile_conservative")).toMatchObject({ status: "NOT_VERIFIED", reason: "no_surviving_msb_child" });
    expect(check(report, "reconcile_after_release")).toMatchObject({ status: "PASS", evidence: { orphan_existed: false } });
    expect(report.overall).toBe("NOT_VERIFIED");
  });
});

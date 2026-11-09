import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROOF_PROBE_PROMPT, PROOF_PROMPT, runSystemdSmoke, SMOKE_CHECK_IDS, SMOKE_PROOF_CHECK_IDS, type SmokeReport } from "../src/f1-systemd-smoke.ts";
import { bareRoot, fakeBun } from "./support/runtime.ts";
import { alive, FakeSystemd, killSleepers } from "./support/fake-systemd.ts";

/**
 * The F1-D smoke and its F1-P1 proof mode, END TO END without systemd, msb or a provider: a user manager stand-in that "starts"
 * and "kills" a stand-in Cockpit (a real HTTP server driven by the unit's own environment file), and real `sleep` processes as
 * the `msb exec` children (harmless: the smoke signals only members of its unit's cgroup, which here is a table). What is proven:
 * the smoke's whole sequence works against the API it will meet on the Arch host, the proof mode sends exactly the prompts it
 * declares, fails when a send is not blocked, stays NOT_VERIFIED when no child survives, and refuses to run without BOTH confirmations.
 * What is NOT proven here: that a real `msb` child survives a real SIGKILL under systemd (only the operator's run can say).
 */
const work = await mkdtemp(join(tmpdir(), "cockpit-f1-proof-"));
afterAll(async () => { killSleepers(); await rm(work, { recursive: true, force: true }); });
const bin = join(work, "bin");
await fakeBun(bin);
await writeFile(join(bin, "msb"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
let counter = 0;

async function smoke(options: { survivors: boolean; proof: boolean; quota?: boolean; blockSends?: boolean }): Promise<{ report: SmokeReport; fake: FakeSystemd; xdg: string; root: string }> {
  const fake = new FakeSystemd(options.survivors);
  fake.world.blockSends = options.blockSends ?? true;
  const xdg = join(work, `run-${++counter}`);
  await mkdir(xdg, { mode: 0o700 });
  fake.xdg = xdg;
  const root = await bareRoot(join(work, `root-${counter}`), "none"); // never the real checkout
  const env = { COCKPIT_F1_SMOKE_CONFIRMED: "yes", COCKPIT_SMOKE_VM: "codex-demo", COCKPIT_PROJECTS_BASE: "/srv/projects", XDG_RUNTIME_DIR: xdg, PATH: bin,
    ...(options.proof ? { COCKPIT_SMOKE_ORPHAN_PROOF: "yes" } : {}), ...(options.quota ? { COCKPIT_SMOKE_QUOTA_CONFIRMED: "yes" } : {}) };
  const report = await runSystemdSmoke({ env, run: fake.run, proc: fake.proc, root, timeoutsMs: { start: 5000, restart: 8000, settle: 700 }, onInterrupt: () => () => {} });
  return { report, fake, xdg, root };
}
const statuses = (report: SmokeReport) => Object.fromEntries(report.checks.map(check => [check.id, check.status]));

test("end to end without the proof: every check passes except the orphan ledger, which is NOT_VERIFIED when no msb child survives the crash", async () => {
  const { report, fake, xdg } = await smoke({ survivors: false, proof: false });
  expect(report.checks.map(check => check.id)).toEqual([...SMOKE_CHECK_IDS]);
  expect(statuses(report)).toEqual({ ...Object.fromEntries(SMOKE_CHECK_IDS.map(id => [id, "PASS"])), orphan_ledger: "NOT_VERIFIED" });
  expect(report.overall).toBe("NOT_VERIFIED");
  expect(fake.world.prompts).toEqual([]); // the default smoke sends no prompt at all
  expect(fake.world.sessions).toBe(0);
  expect(await readdir(join(xdg, "systemd/user"))).toEqual([]); // the runtime unit is gone
});

test("end to end, a surviving child without the proof: the ledger lists it and the smoke ends it", async () => {
  const { report, fake } = await smoke({ survivors: true, proof: false });
  expect(statuses(report).orphan_ledger).toBe("PASS");
  expect(report.overall).toBe("PASS");
  expect(fake.world.orphanPid !== null && alive(fake.world.orphanPid)).toBe(false); // terminated by the smoke, not left behind
});

test("F1-P1 proof: refuses to run without BOTH confirmations, and creates nothing", async () => {
  const { report, fake, xdg } = await smoke({ survivors: true, proof: true, quota: false });
  expect(report.overall).toBe("NOT_VERIFIED");
  expect(report.checks[0]).toMatchObject({ id: "preconditions", status: "NOT_VERIFIED", reason: "quota_confirmation_required" });
  expect(fake.calls.filter(argv => ["start", "daemon-reload", "kill", "stop"].includes(argv[2] ?? ""))).toEqual([]);
  expect(await readdir(xdg)).toEqual([]);
});

test("F1-P1 proof: one real turn is started, the crash leaves an orphan, the ledger lists it, a send is refused, ending it releases the block", async () => {
  const { report, fake } = await smoke({ survivors: true, proof: true, quota: true });
  expect(report.checks.map(check => check.id)).toEqual([...SMOKE_CHECK_IDS, ...SMOKE_PROOF_CHECK_IDS]);
  expect(statuses(report)).toEqual(Object.fromEntries([...SMOKE_CHECK_IDS, ...SMOKE_PROOF_CHECK_IDS].map(id => [id, "PASS"])));
  expect(report.overall).toBe("PASS");
  // Exactly one prompt reached the service: the long one. The probe was refused (409) and never accepted.
  expect(fake.world.prompts).toEqual([PROOF_PROMPT]);
  expect(PROOF_PROBE_PROMPT).not.toBe(PROOF_PROMPT);
  expect(fake.world.sessions).toBe(1);
  expect(report.checks.find(check => check.id === "run_unknown_after_crash")!.evidence).toMatchObject({ status: "unknown" });
  expect(report.checks.find(check => check.id === "orphan_blocks_send")!.evidence).toEqual({ status: 409, error_code: "orphan_process_alive", runs_in_session: 1 }); // and the refused send created no run
  expect(JSON.stringify(report)).not.toContain(PROOF_PROMPT); // the prompt text is not in the evidence
});

test("F1-P1 proof: a send accepted while an orphan is alive is a FAIL (the block is the whole point)", async () => {
  const { report, fake } = await smoke({ survivors: true, proof: true, quota: true, blockSends: false });
  expect(statuses(report).orphan_blocks_send).toBe("FAIL");
  expect(report.checks.find(check => check.id === "orphan_blocks_send")!.reason).toMatch(/^send_not_blocked_202/);
  expect(report.overall).toBe("FAIL");
  expect(fake.world.prompts).toEqual([PROOF_PROMPT, PROOF_PROBE_PROMPT]); // and the harmless probe is the only extra prompt
});

test("F1-P1 proof: when no msb child survives, the orphan checks are NOT_VERIFIED (never PASS) and the run is still left unknown", async () => {
  const { report } = await smoke({ survivors: false, proof: true, quota: true });
  const s = statuses(report);
  expect(s).toMatchObject({ orphan_turn_started: "PASS", crash_restart: "PASS", run_unknown_after_crash: "PASS", orphan_ledger: "NOT_VERIFIED", orphan_blocks_send: "NOT_VERIFIED", orphan_released: "NOT_VERIFIED", cleanup: "PASS" });
  expect(report.overall).toBe("NOT_VERIFIED");
});

test("cleanup is complete after every end-to-end run: no unit file, no work directory, no process left in the cgroup", async () => {
  const { fake, root } = await smoke({ survivors: true, proof: true, quota: true });
  expect(fake.cgroupPids()).toEqual([]);
  const base = join(root, ".cache", "f1-systemd-smoke");
  expect(await readdir(base)).toEqual([]);
});

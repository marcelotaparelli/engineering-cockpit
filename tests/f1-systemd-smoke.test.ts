import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSystemdSmoke, SMOKE_UNIT, terminate } from "../src/f1-systemd-smoke.ts";
import { renderUnit, repoRoot, type Runner } from "../src/service.ts";

/**
 * F1-D smoke, without systemd: the real smoke runs only on the Arch host. Here: preconditions refuse before creating anything,
 * the runtime unit is the real template, and every failure path removes what was created and never enables anything.
 */
const root = repoRoot();
const work = await mkdtemp(join(tmpdir(), "cockpit-f1-smoke-"));
afterAll(async () => { await rm(work, { recursive: true, force: true }); });
const bin = join(work, "bin");
await mkdir(bin);
await symlink(process.execPath, join(bin, "bun"));
await writeFile(join(bin, "msb"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
let runs = 0;
async function runtimeDir(): Promise<string> { const dir = join(work, `run-${++runs}`); await mkdir(dir, { mode: 0o700 }); return dir; }
const baseEnv = (xdg: string, extra: Record<string, string> = {}) => ({ COCKPIT_F1_SMOKE_CONFIRMED: "yes", COCKPIT_SMOKE_VM: "codex-demo", COCKPIT_PROJECTS_BASE: "/srv/projects",
  XDG_RUNTIME_DIR: xdg, PATH: bin, ...extra });
const noProc = { mainNoNewPrivs: () => null, cgroupPids: () => [], isMsb: () => false, alive: () => false, inGroup: () => false };

/** A user manager stand-in: records every call; `loaded` decides what FragmentPath systemd reports. */
function manager(options: { available?: boolean; loaded?: (unitFile: string) => string; activeState?: () => string } = {}) {
  const calls: string[][] = [];
  const unitSnapshots: string[] = [];
  const run: Runner = async argv => {
    calls.push([...argv]);
    if (argv.includes("show-environment")) return { code: options.available === false ? 1 : 0, stdout: "PATH=/usr/bin\n" };
    if (argv.includes("show")) {
      const file = join(currentXdg, "systemd/user", SMOKE_UNIT);
      if (existsSync(file)) unitSnapshots.push(readFileSync(file, "utf8"));
      return { code: 0, stdout: `FragmentPath=${options.loaded ? options.loaded(file) : file}\nActiveState=${options.activeState ? options.activeState() : "inactive"}\nMainPID=0\nNRestarts=0\nNoNewPrivileges=yes\nKillMode=process\n` };
    }
    return { code: 0, stdout: "" };
  };
  return { run, calls, unitSnapshots };
}
let currentXdg = "";

test("F1-D smoke: preconditions refuse with NOT_VERIFIED (exit 2) and create nothing", async () => {
  const cases: Array<[Record<string, string>, string, boolean?]> = [
    [{ COCKPIT_F1_SMOKE_CONFIRMED: "" }, "confirmation_required"],
    [{ COCKPIT_SMOKE_VM: "claude-demo" }, "smoke_vm_must_be_codex"],
    [{ COCKPIT_SMOKE_VM: "demo" }, "smoke_vm_invalid"],
    [{ COCKPIT_PROJECTS_BASE: "relative" }, "host_projects_base_required"],
    [{ XDG_RUNTIME_DIR: "" }, "xdg_runtime_dir_required"],
    [{ PATH: "/nonexistent" }, "service_bun_unavailable"],
    [{}, "systemd_user_manager_unavailable", false],
  ];
  for (const [extra, code, available] of cases) {
    const xdg = await runtimeDir(); currentXdg = xdg;
    const fake = manager({ available: available ?? true });
    const report = await runSystemdSmoke({ env: baseEnv(xdg, extra), run: fake.run, proc: noProc });
    expect(`${code} → ${report.overall} ${report.checks[0]!.reason}`).toBe(`${code} → NOT_VERIFIED ${code}`);
    expect(await readdir(xdg)).toEqual([]);
    expect(fake.calls.filter(argv => !argv.includes("show-environment"))).toEqual([]);
  }
  // A unit with our name that systemd does NOT load from this runtime path is not ours: refused, untouched.
  const xdg = await runtimeDir(); currentXdg = xdg;
  await mkdir(join(xdg, "systemd/user"), { recursive: true });
  await writeFile(join(xdg, "systemd/user", SMOKE_UNIT), "# another run\n");
  const foreign = manager({ loaded: () => "/home/other/.config/systemd/user/engineering-cockpit-f1-smoke.service" });
  const report = await runSystemdSmoke({ env: baseEnv(xdg), run: foreign.run, proc: noProc });
  expect(report.checks[0]).toMatchObject({ status: "NOT_VERIFIED", reason: "smoke_unit_already_present" });
  expect(readFileSync(join(xdg, "systemd/user", SMOKE_UNIT), "utf8")).toBe("# another run\n");
  expect(foreign.calls.filter(argv => argv.includes("stop") || argv.includes("kill"))).toEqual([]);
});

test("F1-D smoke: the leftover of an interrupted smoke (systemd loads exactly this runtime file) is stopped, its cgroup ended and removed before a new run", async () => {
  const xdg = await runtimeDir(); currentXdg = xdg;
  await mkdir(join(xdg, "systemd/user"), { recursive: true });
  await writeFile(join(xdg, "systemd/user", SMOKE_UNIT), "# leftover\n");
  const fake = manager();
  const report = await runSystemdSmoke({ env: baseEnv(xdg), run: fake.run, proc: noProc, timeoutsMs: { start: 100, restart: 100, settle: 10 } });
  expect(report.checks[0]).toMatchObject({ status: "PASS", evidence: { leftover_cleaned: true } });
  const verbs = fake.calls.map(argv => argv.slice(2).join(" "));
  const firstStart = verbs.findIndex(v => v.startsWith("start "));
  expect(verbs.slice(0, firstStart)).toEqual(expect.arrayContaining([`stop ${SMOKE_UNIT}`, `kill --kill-whom=all --signal=SIGKILL ${SMOKE_UNIT}`, `reset-failed ${SMOKE_UNIT}`, "daemon-reload"]));
  expect(fake.unitSnapshots.at(-1)).toContain("NoNewPrivileges=yes"); // the new run wrote the real template over the leftover
  expect(existsSync(join(xdg, "systemd/user", SMOKE_UNIT))).toBe(false);
});

test("F1-D smoke: an interrupt (SIGINT/SIGTERM/SIGHUP) runs the same cleanup once; the unit file and work dir are gone", async () => {
  const xdg = await runtimeDir(); currentXdg = xdg;
  let handler: (() => Promise<void>) | null = null;
  let unregistered = 0;
  const fake = manager();
  // Fire the interrupt while the smoke waits for health (the Cockpit never answers in this test).
  const run: Runner = async argv => { const r = await fake.run(argv); if (argv.includes("start") && handler) setTimeout(() => { void handler!(); }, 20); return r; };
  const report = await runSystemdSmoke({ env: baseEnv(xdg), run, proc: noProc, timeoutsMs: { start: 2000, restart: 100, settle: 10 },
    onInterrupt: h => { handler = h; return () => { unregistered++; }; } });
  expect(report.checks.find(check => check.id === "start")).toMatchObject({ status: "FAIL", reason: "interrupted" });
  expect(report.checks.find(check => check.id === "cleanup")!.status).toBe("PASS");
  expect(unregistered).toBe(1);
  expect(existsSync(join(xdg, "systemd/user", SMOKE_UNIT))).toBe(false);
  const verbs = fake.calls.map(argv => argv.slice(2).join(" "));
  expect(verbs.filter(v => v === `stop ${SMOKE_UNIT}`)).toHaveLength(1); // cleanup ran once, not twice (interrupt + finally)
  expect(verbs).toContain(`kill --kill-whom=all --signal=SIGKILL ${SMOKE_UNIT}`);
});

test("F1-D smoke: cleanup is PASS only when the unit is inactive/failed and its cgroup is empty", async () => {
  const xdg = await runtimeDir(); currentXdg = xdg;
  const stillActive = await runSystemdSmoke({ env: baseEnv(xdg), run: manager({ activeState: () => "active" }).run, proc: noProc, timeoutsMs: { start: 100, restart: 100, settle: 10 } });
  expect(stillActive.checks.find(check => check.id === "cleanup")).toMatchObject({ status: "FAIL", reason: expect.stringContaining("unit_active") });
  const xdg2 = await runtimeDir(); currentXdg = xdg2;
  const group = `/user.slice/user-1000.slice/user@1000.service/app.slice/${SMOKE_UNIT}`;
  const busy = { ...noProc, cgroupPids: (g: string) => g === group ? [4242] : [] };
  const fake = manager(); const run: Runner = async argv => { const r = await fake.run(argv); if (argv.includes("show") && argv.some(a => a.includes("ControlGroup"))) return { code: 0, stdout: `ControlGroup=${group}\n` }; return r; };
  // ControlGroup is only queried after a healthy start; drive the state check directly through the same code path by a start that fails:
  const report = await runSystemdSmoke({ env: baseEnv(xdg2), run, proc: busy, timeoutsMs: { start: 100, restart: 100, settle: 10 } });
  expect(report.checks.find(check => check.id === "cleanup")!.status).toBe("PASS"); // group unknown before start → nothing to verify beyond the unit state
  expect(report.overall).toBe("FAIL");
});

test("F1-D smoke: the runtime unit is the real service template; a failed start is cleaned up and nothing is ever enabled", async () => {
  const xdg = await runtimeDir(); currentXdg = xdg;
  const fake = manager();
  const report = await runSystemdSmoke({ env: baseEnv(xdg), run: fake.run, proc: noProc, timeoutsMs: { start: 300, restart: 300, settle: 10 } });
  expect(report.checks.find(check => check.id === "unit_loaded")!.status).toBe("PASS");
  expect(report.checks.find(check => check.id === "start")).toMatchObject({ status: "FAIL", reason: "service_not_healthy" });
  expect(report.checks.find(check => check.id === "cleanup")!.status).toBe("PASS");
  expect(report.overall).toBe("FAIL");
  // While it existed, the unit was the service template rendered for this checkout (NoNewPrivileges and all).
  const unit = fake.unitSnapshots[0]!;
  const envFile = /^EnvironmentFile=(.+)$/m.exec(unit)![1]!;
  expect(unit).toBe(renderUnit(root, envFile));
  expect(unit).toContain("NoNewPrivileges=yes");
  expect(envFile.startsWith(join(root, ".cache/f1-systemd-smoke/"))).toBe(true);
  // Everything it created is gone; only its own unit was addressed; nothing enabled.
  expect(existsSync(join(xdg, "systemd/user", SMOKE_UNIT))).toBe(false);
  expect(existsSync(envFile)).toBe(false);
  const verbs = fake.calls.map(argv => argv.slice(2).filter(arg => !arg.startsWith("--")).join(" "));
  expect(verbs.some(verb => verb.startsWith("enable"))).toBe(false);
  expect(fake.calls.filter(argv => argv.includes("start") || argv.includes("stop") || argv.includes("kill")).every(argv => argv.includes(SMOKE_UNIT))).toBe(true);
  expect(fake.calls.at(-1)).toEqual(["systemctl", "--user", "daemon-reload"]);
});

test("F1-D smoke: a unit systemd does not load from the runtime dir (other XDG_RUNTIME_DIR) fails and is cleaned up", async () => {
  const xdg = await runtimeDir(); currentXdg = xdg;
  const report = await runSystemdSmoke({ env: baseEnv(xdg), run: manager({ loaded: () => "" }).run, proc: noProc, timeoutsMs: { start: 100, restart: 100, settle: 10 } });
  expect(report.checks.find(check => check.id === "unit_loaded")).toMatchObject({ status: "FAIL", reason: "smoke_unit_not_loaded" });
  expect(report.checks.find(check => check.id === "start")!.status).toBe("NOT_VERIFIED");
  expect(report.checks.find(check => check.id === "cleanup")!.status).toBe("PASS");
  expect(existsSync(join(xdg, "systemd/user", SMOKE_UNIT))).toBe(false);
});

test("F1-D smoke: a signal only reaches msb processes that are members of the smoke unit's own cgroup at that moment", async () => {
  const group = `/user.slice/user-1000.slice/user@1000.service/app.slice/${SMOKE_UNIT}`;
  const spawnSleep = () => Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const bystander = spawnSleep(); // e.g. a reused PID now belonging to another Cockpit's msb exec
  const ours = spawnSleep();
  const proc = { mainNoNewPrivs: () => true, cgroupPids: () => [], isMsb: () => true, alive: (pid: number) => existsSync(`/proc/${pid}`),
    inGroup: (pid: number, g: string) => g === group && pid === ours.pid };
  try {
    await terminate([bystander.pid, ours.pid], proc, group);
    await ours.exited;
    expect(ours.signalCode).toBe("SIGTERM");
    expect(bystander.exitCode).toBeNull();
    expect(existsSync(`/proc/${bystander.pid}`)).toBe(true);
    // A cgroup that is not the smoke unit's, or a non-msb process, is never signalled either.
    await terminate([bystander.pid], { ...proc, inGroup: () => true }, "/user.slice/app.slice/engineering-cockpit.service");
    await terminate([bystander.pid], { ...proc, inGroup: () => true, isMsb: () => false }, group);
    expect(existsSync(`/proc/${bystander.pid}`)).toBe(true);
  } finally { for (const child of [bystander, ours]) { try { child.kill("SIGKILL"); } catch { /* gone */ } await child.exited; } }
});

import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSystemdSmoke, SMOKE_UNIT, terminate } from "../src/f1-systemd-smoke.ts";
import { bareRoot, fakeBun } from "./support/runtime.ts";
import { defaultRunner, renderUnit, repoRoot, type Runner } from "../src/service.ts";

/**
 * F1-D smoke, without systemd: the real smoke runs only on the Arch host. Here: preconditions refuse before creating anything,
 * the runtime unit is the real template, and every failure path removes what was created and never enables anything.
 */
const root = repoRoot();
const work = await mkdtemp(join(tmpdir(), "cockpit-f1-smoke-"));
afterAll(async () => { await rm(work, { recursive: true, force: true }); });
const bin = join(work, "bin");
await fakeBun(bin); // a `bun` reporting the pinned version: independent of the Bun running the suite (tests/support/runtime.ts)
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
  const isolated = await bareRoot(join(work, "root-isolated"), "none"); // never the real checkout: its tools/runtime (Arch) must not change the outcome
  const cases: Array<[Record<string, string>, string, boolean?]> = [
    [{ COCKPIT_F1_SMOKE_CONFIRMED: "" }, "confirmation_required"],
    [{ COCKPIT_SMOKE_VM: "opencode-demo" }, "smoke_vm_must_be_codex_or_claude"],
    // F2: a Claude VM is a valid smoke target, but never the development VM nor one the operator reserved (a real prompt could reach it).
    [{ COCKPIT_SMOKE_VM: "claude-engineering-cockpit" }, "smoke_vm_reserved"],
    [{ COCKPIT_SMOKE_VM: "claude-demo", COCKPIT_RESERVED_VMS: "claude-demo" }, "smoke_vm_reserved"],
    [{ COCKPIT_SMOKE_VM: "codex-demo", COCKPIT_RESERVED_VMS: "codex-demo,claude-other" }, "smoke_vm_reserved"],
    [{ COCKPIT_SMOKE_VM: "claude-demo", COCKPIT_RESERVED_VMS: "not a vm" }, "invalid_reserved_vms"],
    [{ COCKPIT_SMOKE_VM: "claude-demo", COCKPIT_SMOKE_ORPHAN_PROOF: "yes" }, "quota_confirmation_required"],
    [{ COCKPIT_SMOKE_VM: "demo" }, "smoke_vm_invalid"],
    [{ COCKPIT_PROJECTS_BASE: "relative" }, "host_projects_base_required"],
    [{ XDG_RUNTIME_DIR: "" }, "xdg_runtime_dir_required"],
    [{ PATH: "/nonexistent" }, "service_bun_unavailable"],
    [{}, "systemd_user_manager_unavailable", false],
  ];
  for (const [extra, code, available] of cases) {
    const xdg = await runtimeDir(); currentXdg = xdg;
    const fake = manager({ available: available ?? true });
    const report = await runSystemdSmoke({ env: baseEnv(xdg, extra), run: fake.run, proc: noProc, root: isolated });
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

test("F2-M3: after an interrupt `terminate` sends nothing, even to a process of the unit's own cgroup (the cleanup ends the cgroup through systemd)", async () => {
  const group = `/user.slice/user-1000.slice/user@1000.service/app.slice/${SMOKE_UNIT}`;
  const ours = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const proc = { mainNoNewPrivs: () => true, cgroupPids: () => [], isMsb: () => true, alive: (pid: number) => existsSync(`/proc/${pid}`), inGroup: () => true };
  const stop = new AbortController(); stop.abort();
  try {
    await terminate([ours.pid], proc, group, () => true, stop.signal);
    await Bun.sleep(100);
    expect(ours.exitCode).toBeNull();
    expect(existsSync(`/proc/${ours.pid}`)).toBe(true);
  } finally { try { ours.kill("SIGKILL"); } catch { /* gone */ } await ours.exited; }
});

test("F1-D smoke: precondition order is bun, then msb — a good project-local runtime (Arch checkout) moves the refusal to msb; a bad one stays a bun refusal", async () => {
  const good = await bareRoot(join(work, "root-local-good"), {});
  const bad = await bareRoot(join(work, "root-local-bad"), { version: "0.0.1" });
  const none = await bareRoot(join(work, "root-local-none"), "none");
  const outcome = async (root: string, path: string) => {
    const xdg = await runtimeDir(); currentXdg = xdg;
    const report = await runSystemdSmoke({ env: baseEnv(xdg, { PATH: path }), run: manager().run, proc: noProc, root });
    expect(await readdir(xdg)).toEqual([]); // nothing created in any of them
    return report.checks[0]!.reason;
  };
  expect(await outcome(none, "/nonexistent")).toBe("service_bun_unavailable");
  expect(await outcome(bad, "/nonexistent")).toBe("service_bun_unavailable");  // exists but is not the pinned runtime
  expect(await outcome(good, "/nonexistent")).toBe("service_msb_unavailable"); // runtime found through tools/runtime, msb is what is missing
});

test("F2-M3: a VM reserved only in the INSTALLED service's env file is refused too (read-only), and an unreadable file fails closed", async () => {
  const isolated = await bareRoot(join(work, "root-reserved"), "none");
  const config = join(work, "xdg-config"); // stands in for ~/.config: never the real one
  const envDir = join(config, "engineering-cockpit");
  await mkdir(envDir, { recursive: true, mode: 0o700 });
  const envFile = join(envDir, "cockpit.env");
  const cases: Array<[string, string]> = [
    ["# installed by service install\nPORT=8787\nCOCKPIT_RESERVED_VMS=codex-demo,claude-other\n", "smoke_vm_reserved"],
    ["PORT=8787\nnot a line\n", "service_env_unreadable"],
    ["COCKPIT_LOCAL_TOKEN=secret\n", "service_env_unreadable"],
  ];
  // Located but not a readable file (here: a directory where the file should be) is not "absent": fail closed.
  {
    await rm(envFile, { force: true }); await mkdir(envFile);
    const xdg = await runtimeDir(); currentXdg = xdg;
    const report = await runSystemdSmoke({ env: baseEnv(xdg, { XDG_CONFIG_HOME: config }), run: manager().run, proc: noProc, root: isolated });
    expect(`${report.overall} ${report.checks[0]!.reason}`).toBe("NOT_VERIFIED service_env_unreadable");
    await rm(envFile, { recursive: true, force: true });
  }
  // HOME set but unusable (relative): the installed list cannot be located, so the smoke refuses instead of skipping it.
  {
    const xdg = await runtimeDir(); currentXdg = xdg;
    const report = await runSystemdSmoke({ env: baseEnv(xdg, { HOME: "relative/home" }), run: manager().run, proc: noProc, root: isolated });
    expect(`${report.overall} ${report.checks[0]!.reason}`).toBe("NOT_VERIFIED service_env_unreadable");
  }
  for (const [text, code] of cases) {
    await writeFile(envFile, text, { mode: 0o600 });
    const before = readFileSync(envFile, "utf8");
    const xdg = await runtimeDir(); currentXdg = xdg;
    const fake = manager();
    const report = await runSystemdSmoke({ env: baseEnv(xdg, { XDG_CONFIG_HOME: config }), run: fake.run, proc: noProc, root: isolated });
    expect(`${report.overall} ${report.checks[0]!.reason}`).toBe(`NOT_VERIFIED ${code}`);
    expect(await readdir(xdg)).toEqual([]); // nothing created
    expect(fake.calls.filter(argv => !argv.includes("show-environment"))).toEqual([]);
    expect(readFileSync(envFile, "utf8")).toBe(before); // read, never written
  }
});

test("F2-M3: the installed reserved list (plus the shell's) is passed on to the smoke Cockpit, which then refuses those VMs as well", async () => {
  const isolated = await bareRoot(join(work, "root-reserved-pass"), "none");
  const config = join(work, "xdg-config-pass");
  await mkdir(join(config, "engineering-cockpit"), { recursive: true, mode: 0o700 });
  await writeFile(join(config, "engineering-cockpit", "cockpit.env"), "COCKPIT_RESERVED_VMS=claude-daily\n", { mode: 0o600 });
  const xdg = await runtimeDir(); currentXdg = xdg;
  const fake = manager();
  let smokeEnv = "";
  const run: Runner = async argv => {
    if (argv.includes("daemon-reload") && !smokeEnv) {
      const unit = join(xdg, "systemd/user", SMOKE_UNIT);
      const file = existsSync(unit) ? /^EnvironmentFile=-?(.+)$/m.exec(readFileSync(unit, "utf8"))?.[1] : undefined;
      if (file && existsSync(file)) smokeEnv = readFileSync(file, "utf8");
    }
    return fake.run(argv);
  };
  const report = await runSystemdSmoke({ env: baseEnv(xdg, { XDG_CONFIG_HOME: config, COCKPIT_RESERVED_VMS: "codex-other" }), run, proc: noProc, root: isolated,
    timeoutsMs: { start: 300, restart: 100, settle: 10 } });
  expect(report.checks[0]).toMatchObject({ id: "preconditions", status: "PASS" });
  expect(smokeEnv).toMatch(/^COCKPIT_RESERVED_VMS=codex-other,claude-daily$/m);
  expect(existsSync(join(xdg, "systemd/user", SMOKE_UNIT))).toBe(false); // cleaned up (the stand-in Cockpit never answers)
});

test("F2-M3: the smoke runs systemctl/journalctl in their own session, so a second Ctrl+C in the terminal cannot kill the cleanup's `systemctl stop`", async () => {
  const sessionOf = (stat: string) => stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]; // field 6 of /proc/<pid>/stat
  const mine = sessionOf(readFileSync("/proc/self/stat", "utf8"));
  const detached = await defaultRunner({ detached: true })(["cat", "/proc/self/stat"]);
  const attached = await defaultRunner()(["cat", "/proc/self/stat"]);
  expect(detached.code).toBe(0);
  expect(sessionOf(detached.stdout)).not.toBe(mine);
  expect(sessionOf(attached.stdout)).toBe(mine); // the shared default (service commands) is unchanged
  // And the smoke uses the detached runner whenever none is injected.
  expect(readFileSync(join(root, "src/f1-systemd-smoke.ts"), "utf8")).toContain("options.run ?? defaultRunner({ detached: true })");
});

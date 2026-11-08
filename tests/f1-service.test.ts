import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, install, parseEnvFile, renderEnvFile, renderUnit, repoRoot, restartsAfter, rotateToken, servicePaths, uninstall, type Runner } from "../src/service.ts";
import { RuntimeStore, procDatabaseHolders } from "../src/runtime-store.ts";

/**
 * F1 (L3) — the systemd user service, without systemd: the unit is rendered and checked statically (and by
 * `systemd-analyze verify` when present), install/doctor run against a private XDG_CONFIG_HOME and a recording
 * `systemctl` stand-in. Nothing here talks to a real user manager or installs anything on this machine.
 */
const root = repoRoot();
const work = await mkdtemp(join(tmpdir(), "cockpit-f1-service-"));
afterAll(async () => { await rm(work, { recursive: true, force: true }); });
// A directory with the pinned runtime named `bun`, as on the operator's PATH.
const bunDir = join(work, "bin");
await mkdir(bunDir);
await symlink(process.execPath, join(bunDir, "bun"));

function recorder(state: { active?: string; mainPid?: number; environment?: string; fragment?: string } = {}): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async argv => {
    calls.push([...argv]);
    if (argv.includes("show")) return { code: 0, stdout: `ActiveState=${state.active ?? "inactive"}\nSubState=dead\nMainPID=${state.mainPid ?? 0}\nResult=success\nExecMainStatus=0\nNRestarts=0\nUnitFileState=disabled\nFragmentPath=${state.fragment ?? ""}\n` };
    if (argv.includes("show-environment")) return { code: 0, stdout: state.environment ?? "PATH=/usr/bin\n" };
    return { code: 0, stdout: "" };
  };
  return { run, calls };
}
let homes = 0;
async function home(): Promise<string> { const dir = join(work, `home-${++homes}`); await mkdir(dir, { mode: 0o700 }); return dir; }
const mockEnv = (configHome: string, extra: Record<string, string> = {}) => ({ XDG_CONFIG_HOME: configHome, HOME: configHome, PATH: bunDir, COCKPIT_MODE: "mock",
  COCKPIT_ALLOWED_PROJECTS: "demo,lab", PORT: "18787", COCKPIT_DATA_DIR: join(configHome, "data"), ...extra });
const mode = async (path: string) => (await stat(path)).mode & 0o777;

test("unit: user service, token never on the command line, conservative restart and kill policy", () => {
  const unit = renderUnit(root, "/home/op/.config/engineering-cockpit/cockpit.env");
  const directives = unit.split("\n").filter(line => /^[A-Za-z]+=/.test(line));
  expect(directives).toContain(`ExecStart=${root}/scripts/cockpit start`);
  expect(directives).toContain(`WorkingDirectory=${root}`);
  expect(directives).toContain("EnvironmentFile=/home/op/.config/engineering-cockpit/cockpit.env");
  expect(directives).toContain("UnsetEnvironment=COCKPIT_LOCAL_TOKEN");
  expect(directives).toContain("Restart=on-failure");
  expect(directives).toContain("RestartPreventExitStatus=78");
  expect(directives).toContain("KillMode=process");
  expect(directives).toContain("KillSignal=SIGTERM");
  expect(directives).toContain("NoNewPrivileges=yes");
  expect(directives).toContain("UMask=0077");
  expect(directives).toContain("StartLimitBurst=3");
  expect(directives).toContain("WantedBy=default.target");
  // A user unit: no User=/Group= switching, no root-only sandboxing, no secret material anywhere.
  expect(directives.some(line => /^(User|Group|DynamicUser|AmbientCapabilities|CapabilityBoundingSet)=/.test(line))).toBe(false);
  expect(unit).not.toMatch(/COCKPIT_LOCAL_TOKEN=|[a-f0-9]{64}/);
  expect(unit).not.toContain("@ROOT@");
  for (const bad of ["/home/op/my repo", "/home/op/100%", "/home/op/$HOME", "relative/path", "/home/op/../etc", "/home/op/a\"b", "/home/op/a\\nb"]) {
    expect(() => renderUnit(bad, "/x/cockpit.env")).toThrow("service_path_unsafe");
    expect(() => renderUnit(root, `${bad}/cockpit.env`)).toThrow("service_path_unsafe");
  }
});

test("unit: the restart policy the tests drive (restartsAfter) is the one written in the unit", () => {
  expect(restartsAfter({ code: null, signal: "SIGKILL" })).toBe(true);   // crash / OOM: restarted, nothing resent
  expect(restartsAfter({ code: null, signal: "SIGSEGV" })).toBe(true);
  expect(restartsAfter({ code: 1, signal: null })).toBe(true);           // unexpected runtime failure
  expect(restartsAfter({ code: 78, signal: null })).toBe(false);         // refused start: config, credential, port, database owner
  expect(restartsAfter({ code: 0, signal: null })).toBe(false);          // orderly stop
  expect(restartsAfter({ code: null, signal: "SIGTERM" })).toBe(false);
});

const analyze = Bun.which("systemd-analyze");
test.skipIf(!analyze)("unit: systemd-analyze verify accepts the rendered unit", async () => {
  const dir = await home();
  const envFile = join(dir, "cockpit.env");
  await writeFile(envFile, "COCKPIT_MODE=mock\n", { mode: 0o600 });
  const unitFile = join(dir, "engineering-cockpit.service");
  await writeFile(unitFile, renderUnit(root, envFile));
  const result = Bun.spawnSync([analyze!, "verify", "--man=no", unitFile], { stdout: "pipe", stderr: "pipe" });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(output.split("\n").filter(line => line.includes("engineering-cockpit") && !/Cannot add dependency job|Failed to connect/.test(line))).toEqual([]);
  expect(result.exitCode).toBe(0);
});

test("install: private files (0700/0600), token only in its file, unit + daemon-reload, never enable or start", async () => {
  const configHome = await home();
  const { run, calls } = recorder();
  const result = await install({ env: mockEnv(configHome), run });
  const paths = servicePaths({ XDG_CONFIG_HOME: configHome });
  expect(result).toMatchObject({ tokenCreated: true, tokenImported: false, envWritten: true, unitWritten: true });
  expect(await mode(paths.configDir)).toBe(0o700);
  expect(await mode(paths.tokenFile)).toBe(0o600);
  expect(await mode(paths.envFile)).toBe(0o600);
  const token = (await readFile(paths.tokenFile, "utf8")).trim();
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  const envText = await readFile(paths.envFile, "utf8");
  expect(envText).not.toContain(token);
  expect(parseEnvFile(envText)).toEqual({ COCKPIT_MODE: "mock", COCKPIT_ALLOWED_PROJECTS: "demo,lab", PORT: "18787", COCKPIT_DATA_DIR: join(configHome, "data"),
    COCKPIT_LOCAL_TOKEN_FILE: paths.tokenFile, PATH: `${bunDir}:/usr/local/bin:/usr/bin:/bin` });
  expect(await readFile(paths.unitFile, "utf8")).toBe(renderUnit(root, paths.envFile));
  expect(calls).toEqual([["systemctl", "--user", "daemon-reload"]]);

  // Re-install keeps the credential and the operator's settings; --force rewrites settings only.
  await writeFile(paths.envFile, envText.replace("PORT=18787", "PORT=18788"));
  const again = await install({ env: mockEnv(configHome), run });
  expect(again).toMatchObject({ tokenCreated: false, envWritten: false, unitWritten: false });
  expect((await readFile(paths.tokenFile, "utf8")).trim()).toBe(token);
  expect(await readFile(paths.envFile, "utf8")).toContain("PORT=18788");
  await install({ env: mockEnv(configHome), run, force: true });
  expect(await readFile(paths.envFile, "utf8")).toContain("PORT=18787");
  expect(await mode(paths.envFile)).toBe(0o600);
  expect((await readFile(paths.tokenFile, "utf8")).trim()).toBe(token);
  expect(calls.flat().filter(arg => ["enable", "start", "restart"].includes(arg))).toEqual([]);
});

test("install: the operator's current credential can be imported from the environment (never from argv)", async () => {
  const configHome = await home();
  const current = "ab".repeat(32);
  const result = await install({ env: mockEnv(configHome, { COCKPIT_LOCAL_TOKEN: current }), run: recorder().run, importEnvToken: true });
  expect(result.tokenImported).toBe(true);
  const tokenFile = servicePaths({ XDG_CONFIG_HOME: configHome }).tokenFile;
  expect((await readFile(tokenFile, "utf8")).trim()).toBe(current);
  // An explicit import replaces a credential created earlier (e.g. by a mock trial install), atomically and still 0600.
  const other = await home();
  await install({ env: mockEnv(other), run: recorder().run });
  await install({ env: mockEnv(other, { COCKPIT_LOCAL_TOKEN: current }), run: recorder().run, importEnvToken: true, force: true });
  expect((await readFile(servicePaths({ XDG_CONFIG_HOME: other }).tokenFile, "utf8")).trim()).toBe(current);
  expect(await mode(servicePaths({ XDG_CONFIG_HOME: other }).tokenFile)).toBe(0o600);
  const empty = await home();
  await expect(install({ env: mockEnv(empty), run: recorder().run, importEnvToken: true })).rejects.toThrow("local_credential_required");
  expect(await Bun.file(servicePaths({ XDG_CONFIG_HOME: empty }).configDir).exists()).toBe(false);
});

test("install: invalid or unsafe settings are refused before anything is written", async () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ COCKPIT_ALLOWED_PROJECTS: "" }, "local_grants_required"],
    [{ COCKPIT_ALLOWED_PROJECTS: "Demo" }, "local_grants_required"],
    [{ PORT: "0" }, "service_port_required"],
    [{ PORT: "99999" }, "invalid_port"],
    [{ COCKPIT_RESERVED_VMS: "not-a-vm" }, "invalid_reserved_vms"],
    [{ COCKPIT_DATA_DIR: "/data/with space" }, "service_value_unsafe"],
    [{ COCKPIT_MODE: "host", COCKPIT_PROJECTS_BASE: "/srv/projects" }, "service_msb_unavailable"],
    [{ COCKPIT_MODE: "staging" }, "invalid_mode"],
    [{ PATH: "/nonexistent" }, "service_bun_unavailable"],
  ];
  for (const [extra, code] of cases) {
    const configHome = await home();
    let message = "";
    try { await install({ env: mockEnv(configHome, extra), run: recorder().run }); } catch (error) { message = (error as Error).message; }
    expect(`${JSON.stringify(extra)} → ${message}`).toBe(`${JSON.stringify(extra)} → ${code}`);
    expect(await Bun.file(servicePaths({ XDG_CONFIG_HOME: configHome }).tokenFile).exists()).toBe(false);
  }
  // Host mode needs msb on the installing shell's PATH and an absolute projects base.
  const configHome = await home();
  const fakeBin = join(configHome, "bin"); await mkdir(fakeBin); await writeFile(join(fakeBin, "msb"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await install({ env: mockEnv(configHome, { COCKPIT_MODE: "host", COCKPIT_PROJECTS_BASE: "/srv/projects", PATH: `${bunDir}:${fakeBin}` }), run: recorder().run });
  const values = parseEnvFile(await readFile(servicePaths({ XDG_CONFIG_HOME: configHome }).envFile, "utf8"));
  expect(values).toMatchObject({ COCKPIT_MODE: "host", COCKPIT_HOST_CONFIRMED: "yes", COCKPIT_PROJECTS_BASE: "/srv/projects", PATH: `${bunDir}:${fakeBin}:/usr/local/bin:/usr/bin:/bin` });
});

test("settings file: only allowlisted keys; a credential in it is refused", () => {
  expect(() => parseEnvFile("COCKPIT_LOCAL_TOKEN=abc\n")).toThrow("service_env_contains_token");
  expect(() => parseEnvFile("LD_PRELOAD=/tmp/x.so\n")).toThrow("service_env_malformed");
  expect(() => parseEnvFile("PORT=1\nPORT=2\n")).toThrow("service_env_malformed");
  expect(() => parseEnvFile("PORT=\"1\"\n")).toThrow("service_env_malformed");
  expect(() => parseEnvFile("export PORT=1\n")).toThrow("service_env_malformed");
  expect(() => renderEnvFile({ COCKPIT_PROJECTS_BASE: "/a b" })).toThrow("service_value_unsafe");
  expect(parseEnvFile("# comment\n\nPORT=8787\n")).toEqual({ PORT: "8787" });
});

test("doctor: green after install; flags bad permissions, a credential in the manager, a foreign database owner and a busy port — never the token", async () => {
  const configHome = await home();
  const env = mockEnv(configHome, { PORT: String(20000 + Math.floor(Math.random() * 20000)) });
  await install({ env, run: recorder().run });
  const paths = servicePaths({ XDG_CONFIG_HOME: configHome });
  const token = (await readFile(paths.tokenFile, "utf8")).trim();
  const status = async (state = {}) => {
    const report = await doctor({ env, run: recorder({ fragment: paths.unitFile, ...state }).run });
    expect(JSON.stringify(report)).not.toContain(token);
    return Object.fromEntries(report.checks.map(check => [check.id, check.status]));
  };
  expect(await status()).toMatchObject({ unit: "PASS", unit_loaded: "PASS", env_file: "PASS", token_file: "PASS", config: "PASS", bun: "PASS", manager_env: "PASS", runtime_database: "PASS", port: "PASS" });
  expect((await status({ environment: `PATH=/usr/bin\nCOCKPIT_LOCAL_TOKEN=${token}\n` })).manager_env).toBe("WARN");
  // The unit the user manager loads must be this one (e.g. XDG_CONFIG_HOME differs between the shell and the manager).
  expect((await status({ fragment: "" })).unit_loaded).toBe("WARN");
  expect((await status({ fragment: "/home/other/.config/systemd/user/engineering-cockpit.service" })).unit_loaded).toBe("FAIL");

  // Another process owns the runtime database (a terminal Cockpit on the same data/): FAIL, start refused.
  const runtimePath = join(configHome, "data", "runtime-mock", "runtime.sqlite");
  new RuntimeStore(runtimePath).close();
  const holder = Bun.spawn(["sh", "-c", 'exec sleep 30 < "$0"', runtimePath], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    for (const end = Date.now() + 3000; !(procDatabaseHolders(runtimePath) ?? []).includes(holder.pid); await Bun.sleep(10)) if (Date.now() > end) throw new Error("holder not seen");
    expect((await status()).runtime_database).toBe("FAIL");
    expect((await status({ active: "active", mainPid: holder.pid })).runtime_database).toBe("PASS"); // held by the service itself
  } finally { holder.kill("SIGKILL"); await holder.exited; }

  const listener = createServer().listen(Number(env.PORT), "127.0.0.1");
  await new Promise(resolve => listener.once("listening", resolve));
  try {
    expect((await status()).port).toBe("FAIL");
    expect((await status({ active: "active" })).port).toBe("PASS");
  } finally { listener.close(); }

  await chmod(paths.envFile, 0o644);
  await chmod(paths.tokenFile, 0o640);
  expect(await status()).toMatchObject({ env_file: "FAIL", token_file: "FAIL" });
  await rm(paths.unitFile);
  expect((await status()).unit).toBe("FAIL");
});

test("rotate-token replaces the credential atomically (0600); uninstall refuses while active and keeps settings, token and data", async () => {
  const configHome = await home();
  const env = mockEnv(configHome);
  await install({ env, run: recorder().run });
  const paths = servicePaths({ XDG_CONFIG_HOME: configHome });
  const before = await readFile(paths.tokenFile, "utf8");
  await rotateToken({ XDG_CONFIG_HOME: configHome });
  const after = await readFile(paths.tokenFile, "utf8");
  expect(after).not.toBe(before);
  expect(after.trim()).toMatch(/^[a-f0-9]{64}$/);
  expect(await mode(paths.tokenFile)).toBe(0o600);
  // Atomic writes leave no temporary files behind.
  expect((await readdir(paths.configDir)).sort()).toEqual(["cockpit.env", "token"]);
  expect((await readdir(paths.unitDir)).sort()).toEqual(["engineering-cockpit.service"]);
  await expect(uninstall({ env, run: recorder({ active: "active" }).run })).rejects.toThrow("service_active");
  expect(await Bun.file(paths.unitFile).exists()).toBe(true);
  await uninstall({ env, run: recorder().run });
  expect(await Bun.file(paths.unitFile).exists()).toBe(false);
  expect(await Bun.file(paths.envFile).exists()).toBe(true);
  expect(await Bun.file(paths.tokenFile).exists()).toBe(true);
});

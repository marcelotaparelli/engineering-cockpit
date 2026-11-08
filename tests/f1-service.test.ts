import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { bareRoot, fakeBun, pinnedVersion } from "./support/runtime.ts";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { configuredTokenFile, doctor, install, parseEnvFile, renderEnvFile, renderUnit, repoRoot, resolvePinnedRuntime, restartsAfter, rotateToken, rotationEffectMessage, servicePaths, uninstall, type Runner } from "../src/service.ts";
import { RuntimeStore, procDatabaseHolders } from "../src/runtime-store.ts";

/**
 * F1 (L3) — the systemd user service, without systemd: the unit is rendered and checked statically (and by
 * `systemd-analyze verify` when present), install/doctor run against a private XDG_CONFIG_HOME and a recording
 * `systemctl` stand-in. Nothing here talks to a real user manager or installs anything on this machine.
 */
const root = repoRoot();
const work = await mkdtemp(join(tmpdir(), "cockpit-f1-service-"));
afterAll(async () => { await rm(work, { recursive: true, force: true }); });
// A directory with a `bun` reporting the pinned version, as on the operator's PATH (hermetic: see tests/support/runtime.ts).
const bunDir = join(work, "bin");
await fakeBun(bunDir);

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
  const isolated = await bareRoot(join(work, "root-isolated"), "none"); // no project-local runtime, whatever the checkout has
  for (const [extra, code] of cases) {
    const configHome = await home();
    let message = "";
    try { await install({ env: mockEnv(configHome, extra), run: recorder().run, root: isolated }); } catch (error) { message = (error as Error).message; }
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

// ---------------------------------------------------------------- F1-B: rotate-token follows cockpit.env, verifies, rolls back
async function customSetup() {
  const configHome = await home();
  await install({ env: mockEnv(configHome), run: recorder().run });
  const paths = servicePaths({ XDG_CONFIG_HOME: configHome });
  const vault = join(configHome, "vault");
  await mkdir(vault, { mode: 0o700 });
  const custom = join(vault, "cockpit-secret");
  const original = "cd".repeat(32);
  await writeFile(custom, `${original}\n`, { mode: 0o600 });
  const envText = await readFile(paths.envFile, "utf8");
  await writeFile(paths.envFile, envText.replace(`COCKPIT_LOCAL_TOKEN_FILE=${paths.tokenFile}`, `COCKPIT_LOCAL_TOKEN_FILE=${custom}`), { mode: 0o600 });
  const defaultBefore = await readFile(paths.tokenFile, "utf8");
  return { configHome, paths, vault, custom, original, defaultBefore };
}

test("F1-B: rotate-token rotates the file named in cockpit.env (custom path), never the default one", async () => {
  const { configHome, paths, vault, custom, original, defaultBefore } = await customSetup();
  expect(configuredTokenFile({ XDG_CONFIG_HOME: configHome })).toBe(custom);
  const result = await rotateToken({ XDG_CONFIG_HOME: configHome });
  expect(result).toEqual({ tokenFile: custom });
  const rotated = (await readFile(custom, "utf8")).trim();
  expect(rotated).toMatch(/^[a-f0-9]{64}$/);
  expect(rotated).not.toBe(original);
  expect(await mode(custom)).toBe(0o600);
  expect(await readFile(paths.tokenFile, "utf8")).toBe(defaultBefore); // the wrong file is untouched
  expect((await readdir(vault)).sort()).toEqual(["cockpit-secret"]); // no temporary file left
  expect(JSON.stringify(result)).not.toContain(rotated);
});

test("F1-B: no rotation without a valid, private configuration and credential file — and nothing is created or changed", async () => {
  const notInstalled = await home();
  await expect(rotateToken({ XDG_CONFIG_HOME: notInstalled })).rejects.toThrow("service_not_installed");
  expect(await Bun.file(servicePaths({ XDG_CONFIG_HOME: notInstalled }).tokenFile).exists()).toBe(false);

  const cases: Array<[string, (ctx: Awaited<ReturnType<typeof customSetup>>) => Promise<void>, string]> = [
    ["settings readable by others", async c => { await chmod(c.paths.envFile, 0o644); }, "service_env_file_insecure"],
    ["settings without a credential file", async c => { await writeFile(c.paths.envFile, (await readFile(c.paths.envFile, "utf8")).replace(/^COCKPIT_LOCAL_TOKEN_FILE=.*\n/m, "")); }, "local_credential_file_required"],
    ["traversal in the configured path", async c => { await writeFile(c.paths.envFile, (await readFile(c.paths.envFile, "utf8")).replace(c.custom, `${c.vault}/../vault/cockpit-secret`)); }, "local_credential_file_invalid"],
    ["configured file missing", async c => { await rm(c.custom); }, "local_credential_file_invalid"],
    ["configured file readable by others", async c => { await chmod(c.custom, 0o644); }, "local_credential_file_insecure"],
    ["configured file is a symlink", async c => { await rm(c.custom); await symlink(c.paths.tokenFile, c.custom); }, "local_credential_file_invalid"],
    ["configured file malformed", async c => { await writeFile(c.custom, "not-a-token\n"); }, "local_credential_file_invalid"],
  ];
  for (const [label, breakIt, code] of cases) {
    const ctx = await customSetup();
    await breakIt(ctx);
    const snapshot = async () => [await readFile(ctx.paths.tokenFile, "utf8"), await readFile(ctx.custom, "utf8").catch(() => "<absent>"), (await readdir(ctx.vault)).sort().join(",")];
    const before = await snapshot();
    let message = "";
    try { await rotateToken({ XDG_CONFIG_HOME: ctx.configHome }); } catch (error) { message = (error as Error).message; }
    expect(`${label} → ${message}`).toBe(`${label} → ${code}`);
    expect(await snapshot()).toEqual(before);
    expect(message).not.toContain(ctx.original);
  }
});

test("F1-B: a failed or unverifiable write is rolled back to the previous credential and reported as failed", async () => {
  const realRead = (path: string) => readFileSync(path, "utf8").trim();
  // 1. The write itself fails (e.g. disk full): the previous credential stays, the rotation is reported as failed.
  {
    const ctx = await customSetup();
    let message = "";
    try { await rotateToken({ XDG_CONFIG_HOME: ctx.configHome }, { write: async () => { throw new Error("ENOSPC"); }, read: realRead, generate: () => "ef".repeat(32) }); }
    catch (error) { message = (error as Error).message; }
    expect(message).toBe("credential_rotation_failed");
    expect((await readFile(ctx.custom, "utf8")).trim()).toBe(ctx.original);
    expect(await mode(ctx.custom)).toBe(0o600);
    expect((await readdir(ctx.vault)).sort()).toEqual(["cockpit-secret"]);
  }
  // 1b. A write that failed before its rename left the file intact: no rollback rewrite happens (same inode, same mtime).
  {
    const ctx = await customSetup();
    const before = await stat(ctx.custom);
    await Bun.sleep(20);
    await expect(rotateToken({ XDG_CONFIG_HOME: ctx.configHome }, { write: async () => { throw new Error("ENOSPC"); }, read: realRead, generate: () => "ef".repeat(32) })).rejects.toThrow("credential_rotation_failed");
    const after = await stat(ctx.custom);
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
  }
  // 2. The write "succeeds" but the file does not hold the new value: restored, reported, never claimed as rotated.
  {
    const ctx = await customSetup();
    let message = "";
    try {
      await rotateToken({ XDG_CONFIG_HOME: ctx.configHome }, { write: async path => { await writeFile(path, `${"00".repeat(32)}\n`, { mode: 0o600 }); }, read: realRead, generate: () => "ef".repeat(32) });
    } catch (error) { message = (error as Error).message; }
    expect(message).toBe("credential_rotation_failed");
    expect((await readFile(ctx.custom, "utf8")).trim()).toBe(ctx.original);
    expect(message).not.toContain("ef".repeat(32));
  }
  // 3. A generator returning the same or a malformed value is refused before anything is written.
  {
    const ctx = await customSetup();
    for (const generate of [() => ctx.original, () => "XYZ"]) {
      await expect(rotateToken({ XDG_CONFIG_HOME: ctx.configHome }, { write: async () => { throw new Error("must not write"); }, read: realRead, generate })).rejects.toThrow("credential_rotation_failed");
    }
    expect((await readFile(ctx.custom, "utf8")).trim()).toBe(ctx.original);
  }
});

test("F1-B: the message about when the rotated credential applies never claims a stopped service when the state is unknown", () => {
  expect(rotationEffectMessage({ active: "active" })).toContain("ANTERIOR");
  expect(rotationEffectMessage({ active: "inactive" })).toContain("próximo ./scripts/cockpit service start");
  for (const active of ["unknown", "", "weird"]) {
    const message = rotationEffectMessage({ active });
    expect(message).toContain("desconhecido");
    expect(message).not.toContain("não está em execução");
  }
});

// ---------------------------------------------------------------- runtime resolution = what scripts/cockpit would start
let roots = 0;
const newRoot = (local?: Parameters<typeof bareRoot>[1]) => bareRoot(join(work, `root-${++roots}`), local);
const binWith = async (version?: string, mode?: number) => { const dir = join(work, `bin-${++roots}`); await fakeBun(dir, version, mode); return dir; };

test("runtime resolution: PATH wins when it reports the pinned version; otherwise the project-local runtime, also only at the pinned version and executable", async () => {
  const good = await binWith();
  const wrong = await binWith("0.0.1");
  const notExecutable = await binWith(pinnedVersion, 0o644);
  expect(resolvePinnedRuntime(good, await newRoot("none"))).toEqual({ source: "path", dir: good });
  expect(resolvePinnedRuntime(`${wrong}:${good}`, await newRoot("none"))).toEqual({ source: "path", dir: good }); // first PATH entry at the right version
  expect(resolvePinnedRuntime(good, await newRoot({}))).toEqual({ source: "path", dir: good });                    // PATH before local, like the launcher
  expect(resolvePinnedRuntime("/nonexistent", await newRoot({}))).toEqual({ source: "local" });
  expect(resolvePinnedRuntime(wrong, await newRoot({}))).toEqual({ source: "local" });                             // wrong PATH bun falls back to a good local one
  expect(resolvePinnedRuntime(undefined, await newRoot({}))).toEqual({ source: "local" });
  // Nothing usable: absent, wrong version, not executable, relative PATH entries.
  expect(resolvePinnedRuntime("/nonexistent", await newRoot("none"))).toBeNull();
  expect(resolvePinnedRuntime(wrong, await newRoot("none"))).toBeNull();
  expect(resolvePinnedRuntime(notExecutable, await newRoot("none"))).toBeNull();
  expect(resolvePinnedRuntime(`relative/bin:.`, await newRoot("none"))).toBeNull();
});

test("a candidate bun that hangs is bounded by a deadline and refused, not waited for", async () => {
  const dir = join(work, `bin-hang-${++roots}`);
  await mkdir(dir);
  await writeFile(join(dir, "bun"), "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
  const started = Date.now();
  expect(resolvePinnedRuntime(dir, await newRoot("none"))).toBeNull();
  expect(Date.now() - started).toBeLessThan(15_000);
}, 20_000);

test("regression (Arch): a project-local runtime that exists but is the wrong version or not executable is NOT accepted — install, doctor and the launcher agree", async () => {
  for (const local of [{ version: "0.0.1" }, { mode: 0o644 }] as const) {
    const configHome = await home();
    const rootWithBadLocal = await newRoot(local);
    await expect(install({ env: mockEnv(configHome, { PATH: "/nonexistent" }), run: recorder().run, root: rootWithBadLocal })).rejects.toThrow("service_bun_unavailable");
    expect(await Bun.file(servicePaths({ XDG_CONFIG_HOME: configHome }).tokenFile).exists()).toBe(false); // nothing written
  }
});

test("a good project-local runtime is accepted without PATH (as on Arch); the unit PATH does not include it; the launcher resolves it", async () => {
  const configHome = await home();
  const withLocal = await newRoot({});
  await install({ env: mockEnv(configHome, { PATH: "/nonexistent" }), run: recorder().run, root: withLocal });
  const paths = servicePaths({ XDG_CONFIG_HOME: configHome });
  const values = parseEnvFile(await readFile(paths.envFile, "utf8"));
  expect(values.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
  const report = await doctor({ env: mockEnv(configHome, { PATH: "/nonexistent" }), run: recorder({ fragment: paths.unitFile }).run, root: withLocal });
  expect(report.checks.find(check => check.id === "bun")).toMatchObject({ status: "PASS" });
  expect(report.checks.find(check => check.id === "bun")!.detail).toContain("runtime local");
});

test("doctor: the bun check FAILs for a service whose only runtime is a project-local one of the wrong version", async () => {
  const configHome = await home();
  const good = await newRoot({});
  await install({ env: mockEnv(configHome, { PATH: "/nonexistent" }), run: recorder().run, root: good });
  const paths = servicePaths({ XDG_CONFIG_HOME: configHome });
  const broken = await newRoot({ version: "0.0.1" }); // the checkout's runtime was replaced by another version afterwards
  const report = await doctor({ env: mockEnv(configHome, { PATH: "/nonexistent" }), run: recorder({ fragment: paths.unitFile }).run, root: broken });
  expect(report.checks.find(check => check.id === "bun")).toMatchObject({ status: "FAIL" });
});

test("the real launcher (scripts/cockpit) and resolvePinnedRuntime agree on the same roots — no checkout can pass install yet fail to start", async () => {
  // A PATH with only the utilities the launcher needs (no bun anywhere), so the machine's own Bun never decides the outcome.
  const tools = join(work, "launcher-path");
  await mkdir(tools);
  for (const name of ["dirname", "cat", "mkdir"]) { const found = Bun.which(name); if (found) await symlink(found, join(tools, name)); }
  const launch = async (root: string) => {
    await mkdir(join(root, "scripts"), { recursive: true });
    await Bun.write(join(root, "scripts/cockpit"), Bun.file(join(repoRoot(), "scripts/cockpit")));
    await chmod(join(root, "scripts/cockpit"), 0o755);
    const child = Bun.spawn([join(root, "scripts/cockpit"), "host-check"], { cwd: root, env: { PATH: tools }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code: await child.exited, stdout: stdout.trim(), stderr: stderr.trim() };
  };
  const goodLocal = await newRoot({});
  const wrongLocal = await newRoot({ version: "0.0.1" });
  const noLocal = await newRoot("none");
  const notExecutable = await newRoot({ mode: 0o644 });
  // Launcher: runs the local runtime (the stand-in prints its version and exits 0) exactly when resolution says "local".
  expect(resolvePinnedRuntime(tools, goodLocal)).toEqual({ source: "local" });
  expect(await launch(goodLocal)).toMatchObject({ code: 0, stdout: pinnedVersion });
  for (const root of [wrongLocal, noLocal, notExecutable]) {
    expect(resolvePinnedRuntime(tools, root)).toBeNull();
    const result = await launch(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Bun (unavailable|version mismatch)/);
  }
});

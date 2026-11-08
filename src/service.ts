import { randomBytes } from "node:crypto";
import { constants, existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { connect } from "node:net";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, EXIT_STARTUP_REFUSED, readLocalCredentialFile } from "./config.ts";
import { SafeError, safeCode } from "./model.ts";
import { procDatabaseHolders } from "./runtime-store.ts";

/**
 * F1 (L3): the Cockpit as a systemd USER service. Everything here is explicit and local: files under the operator's
 * ~/.config, `systemctl --user` with a fixed argv (no shell), and checks that read metadata only. Nothing is enabled or
 * started by `install`; nothing reads or prints the credential except the Cockpit itself (from its 0600 file).
 */
export const SERVICE_UNIT = "engineering-cockpit.service";
export const DEFAULT_SERVICE_PORT = "8787";
const TEMPLATE = new URL("../tools/systemd/cockpit.service", import.meta.url);
/** Keys the service environment file may hold. Never COCKPIT_LOCAL_TOKEN. */
export const SERVICE_ENV_KEYS = ["COCKPIT_MODE", "COCKPIT_HOST_CONFIRMED", "COCKPIT_PROJECTS_BASE", "COCKPIT_ALLOWED_PROJECTS", "PORT", "COCKPIT_DATA_DIR",
  "COCKPIT_RESERVED_VMS", "COCKPIT_LOCAL_TOKEN_FILE", "PATH", "LANG"] as const;
type ServiceKey = typeof SERVICE_ENV_KEYS[number];
/** Paths written into the unit or the environment file: absolute, no whitespace, quotes, `%` (unit specifiers), `$` or `\`. */
const SAFE_PATH = /^\/[A-Za-z0-9._+@\/-]*$/;
const SAFE_VALUE = /^[A-Za-z0-9._,:+@\/=-]*$/;

export interface ServicePaths { configDir: string; envFile: string; tokenFile: string; unitDir: string; unitFile: string }
export interface Runner { (argv: readonly string[]): Promise<{ code: number; stdout: string }> }

export function repoRoot(): string { return fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, ""); }

export function servicePaths(env: Record<string, string | undefined> = process.env): ServicePaths {
  const home = env.HOME;
  const base = env.XDG_CONFIG_HOME || (home ? `${home}/.config` : "");
  if (!base.startsWith("/") || !SAFE_PATH.test(base) || base.split("/").includes("..")) throw new SafeError("service_config_home_invalid");
  const configDir = `${base}/engineering-cockpit`;
  return { configDir, envFile: `${configDir}/cockpit.env`, tokenFile: `${configDir}/token`, unitDir: `${base}/systemd/user`, unitFile: `${base}/systemd/user/${SERVICE_UNIT}` };
}

export function renderUnit(root: string, envFile: string, template = readFileSync(TEMPLATE, "utf8")): string {
  for (const path of [root, envFile]) if (!SAFE_PATH.test(path) || path.split("/").includes("..")) throw new SafeError("service_path_unsafe");
  return template.replaceAll("@ROOT@", root).replaceAll("@ENV_FILE@", envFile);
}

export function renderEnvFile(values: Partial<Record<ServiceKey, string>>): string {
  const lines = ["# Engineering Cockpit service settings (non-secret). Written by ./scripts/cockpit service install; mode 0600.",
    "# The credential is NOT here: it lives in COCKPIT_LOCAL_TOKEN_FILE. Edit, then: ./scripts/cockpit service restart"];
  for (const key of SERVICE_ENV_KEYS) {
    const value = values[key];
    if (value === undefined) continue;
    if (!SAFE_VALUE.test(value)) throw new SafeError("service_value_unsafe");
    lines.push(`${key}=${value}`);
  }
  return lines.join("\n") + "\n";
}

/** Strict reader for the file this module writes: comments, blank lines and allowlisted KEY=value lines only. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!match) throw new SafeError("service_env_malformed");
    const [, key, value] = match as unknown as [string, string, string];
    if (key === "COCKPIT_LOCAL_TOKEN") throw new SafeError("service_env_contains_token");
    if (!(SERVICE_ENV_KEYS as readonly string[]).includes(key) || key in values || !SAFE_VALUE.test(value)) throw new SafeError("service_env_malformed");
    values[key] = value;
  }
  return values;
}

/** Directories of the executables the service needs, taken from the installing shell's PATH; system dirs last. */
export function servicePath(env: Record<string, string | undefined>, mode: "mock" | "host", root = repoRoot()): string {
  const dirs: string[] = [];
  const find = (name: string): string | null => {
    for (const dir of (env.PATH ?? "").split(delimiter)) {
      if (!dir.startsWith("/")) continue;
      try { const file = join(dir, name); if (statSync(file).isFile()) return dir; } catch { /* not here */ }
    }
    return null;
  };
  const pinned = (readFileSync(join(root, ".bun-version"), "utf8")).trim();
  const bunDir = find("bun");
  const local = join(root, "tools/runtime/node_modules/.bin");
  if (bunDir && bunVersion(join(bunDir, "bun")) === pinned) dirs.push(bunDir);
  else if (!existsSync(join(local, "bun"))) throw new SafeError("service_bun_unavailable");
  if (mode === "host") {
    const msbDir = find("msb");
    if (!msbDir) throw new SafeError("service_msb_unavailable");
    dirs.push(msbDir);
  }
  for (const dir of ["/usr/local/bin", "/usr/bin", "/bin"]) dirs.push(dir);
  const unique = [...new Set(dirs)];
  for (const dir of unique) if (!SAFE_PATH.test(dir)) throw new SafeError("service_path_unsafe");
  return unique.join(":");
}
function bunVersion(path: string): string | null {
  try {
    const result = Bun.spawnSync([path, "--version"], { stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin" } });
    return result.exitCode === 0 ? result.stdout.toString().trim() : null;
  } catch { return null; }
}

/** The service settings from the installing shell (mode, projects, port, data dir, reserved VMs). Validated like a start. */
export function serviceSettings(env: Record<string, string | undefined>, paths: ServicePaths, root = repoRoot()): Partial<Record<ServiceKey, string>> {
  const mode = env.COCKPIT_MODE ?? "host";
  if (mode !== "host" && mode !== "mock") throw new SafeError("invalid_mode");
  const values: Partial<Record<ServiceKey, string>> = {
    COCKPIT_MODE: mode,
    ...(mode === "host" ? { COCKPIT_HOST_CONFIRMED: "yes", COCKPIT_PROJECTS_BASE: env.COCKPIT_PROJECTS_BASE ?? "" } : {}),
    COCKPIT_ALLOWED_PROJECTS: env.COCKPIT_ALLOWED_PROJECTS ?? "",
    PORT: env.PORT ?? DEFAULT_SERVICE_PORT,
    ...(env.COCKPIT_DATA_DIR !== undefined ? { COCKPIT_DATA_DIR: env.COCKPIT_DATA_DIR } : {}),
    ...(env.COCKPIT_RESERVED_VMS !== undefined ? { COCKPIT_RESERVED_VMS: env.COCKPIT_RESERVED_VMS } : {}),
    COCKPIT_LOCAL_TOKEN_FILE: paths.tokenFile,
    PATH: servicePath(env, mode, root),
    ...(env.LANG && SAFE_VALUE.test(env.LANG) ? { LANG: env.LANG } : {}),
  };
  if (values.PORT === "0") throw new SafeError("service_port_required"); // the browser needs a stable address
  validateSettings(values);
  return values;
}

/** Same checks as a real start (minus the credential, which is checked from its file separately). */
export function validateSettings(values: Record<string, string | undefined>): ReturnType<typeof config> {
  if (!values.COCKPIT_LOCAL_TOKEN_FILE) throw new SafeError("local_credential_file_required");
  const settings = config({ ...values }, () => "f".repeat(64));
  // Same rule as the Cockpit start: the grants must be explicit and valid (LocalSecurity refuses anything else).
  if (settings.allowedProjects.length === 0 || settings.allowedProjects.some(project => !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) ||
    new Set(settings.allowedProjects).size !== settings.allowedProjects.length) throw new SafeError("local_grants_required");
  if (settings.port === 0) throw new SafeError("service_port_required");
  return settings;
}

/**
 * Atomic write: a fresh temporary file in the same directory (O_EXCL|O_NOFOLLOW, never through a link), fsync, then rename
 * over the target (rename replaces a link itself, never follows it). A crash leaves either the old or the new file, never a
 * partial one; the temporary file is removed if anything fails.
 */
async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  const temporary = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
const writePrivate = (path: string, content: string) => writeAtomic(path, content, 0o600);
async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new SafeError("service_config_dir_insecure");
  await chmod(path, 0o700);
}
export function newToken(): string { return randomBytes(32).toString("hex"); }

export interface InstallResult { tokenCreated: boolean; tokenImported: boolean; envWritten: boolean; unitWritten: boolean; paths: ServicePaths }

/**
 * Writes the token (only if absent), the environment file (only if absent, or with `force`) and the unit, then
 * `daemon-reload`. Never enables, starts or restarts anything.
 */
export async function install(options: { env: Record<string, string | undefined>; run: Runner; force?: boolean; importEnvToken?: boolean; root?: string }): Promise<InstallResult> {
  const root = options.root ?? repoRoot();
  const paths = servicePaths(options.env);
  const settings = serviceSettings(options.env, paths, root); // validate everything before writing anything
  const unit = renderUnit(root, paths.envFile);
  const envText = renderEnvFile(settings);
  if (options.importEnvToken && !/^[a-f0-9]{64}$/.test(options.env.COCKPIT_LOCAL_TOKEN ?? "")) throw new SafeError("local_credential_required");
  await ensurePrivateDir(paths.configDir);
  let tokenCreated = false;
  let tokenImported = false;
  if (isLink(paths.tokenFile)) throw new SafeError("local_credential_file_invalid");
  if (options.importEnvToken) {
    // Explicit operator intent: the current terminal credential becomes the service's, replacing any earlier file (atomic, 0600).
    const imported = options.env.COCKPIT_LOCAL_TOKEN ?? "";
    if (!/^[a-f0-9]{64}$/.test(imported)) throw new SafeError("local_credential_required");
    await writePrivate(paths.tokenFile, `${imported}\n`);
    tokenImported = true;
  } else if (!existsSync(paths.tokenFile)) {
    await writePrivate(paths.tokenFile, `${newToken()}\n`);
    tokenCreated = true;
  }
  readLocalCredentialFile(paths.tokenFile); // an existing file must already be private and well-formed
  let envWritten = false;
  if (options.force || (!existsSync(paths.envFile) && !isLink(paths.envFile))) {
    await writePrivate(paths.envFile, envText);
    envWritten = true;
  }
  await mkdir(paths.unitDir, { recursive: true, mode: 0o755 });
  if (isLink(paths.unitFile)) throw new SafeError("service_unit_link_denied");
  const current = existsSync(paths.unitFile) ? await readFile(paths.unitFile, "utf8") : null;
  if (current !== unit) await writeAtomic(paths.unitFile, unit, 0o644);
  const reload = await options.run(["systemctl", "--user", "daemon-reload"]);
  if (reload.code !== 0) throw new SafeError("systemctl_daemon_reload_failed");
  return { tokenCreated, tokenImported, envWritten, unitWritten: current !== unit, paths };
}
function isLink(path: string): boolean { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } }

/**
 * The credential file the service really uses: `COCKPIT_LOCAL_TOKEN_FILE` from the private settings file (never a guess).
 * The settings file must be private and well-formed, and the credential file must already exist, be private and valid:
 * nothing is created or replaced in a place the configuration does not name.
 */
export function configuredTokenFile(env: Record<string, string | undefined> = process.env): string {
  const paths = servicePaths(env);
  if (!existsSync(paths.envFile) && !isLink(paths.envFile)) throw new SafeError("service_not_installed");
  if (!fileMode(paths.envFile).ok) throw new SafeError("service_env_file_insecure");
  const target = parseEnvFile(readFileSync(paths.envFile, "utf8")).COCKPIT_LOCAL_TOKEN_FILE;
  if (!target) throw new SafeError("local_credential_file_required");
  if (!SAFE_PATH.test(target) || target.split("/").includes("..")) throw new SafeError("local_credential_file_invalid");
  readLocalCredentialFile(target); // exists, regular, private, owned, valid; otherwise refuse
  return target;
}

export interface RotationDeps { write(path: string, content: string): Promise<void>; read(path: string): string; generate(): string }
const ROTATION: RotationDeps = { write: (path, content) => writePrivate(path, content), read: readLocalCredentialFile, generate: newToken };

/**
 * F1-B: replaces the configured credential atomically (temp 0600 + rename) and verifies it by reading it back. On any failure
 * the previous credential is restored (atomically) and the rotation is reported as failed: never a rotation that did not
 * happen, never a file the configuration does not name. The value is never returned or printed. The running Cockpit keeps
 * accepting the previous credential until its next start/restart (which also revokes every browser session).
 */
export async function rotateToken(env: Record<string, string | undefined> = process.env, deps: RotationDeps = ROTATION): Promise<{ tokenFile: string }> {
  const tokenFile = configuredTokenFile(env);
  const previous = deps.read(tokenFile);
  const next = deps.generate();
  if (!/^[a-f0-9]{64}$/.test(next) || next === previous) throw new SafeError("credential_rotation_failed");
  try {
    await deps.write(tokenFile, `${next}\n`);
    if (deps.read(tokenFile) !== next) throw new SafeError("credential_rotation_unverified");
  } catch {
    let restored = false;
    try { await writePrivate(tokenFile, `${previous}\n`); restored = readLocalCredentialFile(tokenFile) === previous; } catch { /* reported below */ }
    throw new SafeError(restored ? "credential_rotation_failed" : "credential_rotation_rollback_failed");
  }
  return { tokenFile };
}

export async function uninstall(options: { env: Record<string, string | undefined>; run: Runner }): Promise<ServicePaths> {
  const paths = servicePaths(options.env);
  const state = await serviceState(options.run);
  if (state.active === "active" || state.active === "activating" || state.active === "reloading") throw new SafeError("service_active");
  await rm(paths.unitFile, { force: true });
  await options.run(["systemctl", "--user", "daemon-reload"]);
  return paths; // env file, token and data are kept on purpose
}

export interface ServiceState { active: string; sub: string; mainPid: number; result: string; exitStatus: number | null; restarts: number | null; enabled: string; fragment: string }
export async function serviceState(run: Runner): Promise<ServiceState> {
  const show = await run(["systemctl", "--user", "show", SERVICE_UNIT, "--property=ActiveState,SubState,MainPID,Result,ExecMainStatus,NRestarts,UnitFileState,FragmentPath"]);
  const values = Object.fromEntries(show.stdout.split("\n").filter(line => line.includes("=")).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  const int = (value: string | undefined) => value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
  return { active: values.ActiveState || "unknown", sub: values.SubState || "unknown", mainPid: int(values.MainPID) ?? 0, result: values.Result || "unknown",
    exitStatus: int(values.ExecMainStatus), restarts: int(values.NRestarts), enabled: values.UnitFileState || "unknown",
    fragment: values.FragmentPath || "" };
}

/** Mirrors the unit's restart policy (Restart=on-failure + RestartPreventExitStatus=78); the unit test keeps both in sync. */
export function restartsAfter(exit: { code: number | null; signal: string | null }): boolean {
  if (exit.signal !== null && exit.signal !== "SIGTERM" && exit.signal !== "SIGINT" && exit.signal !== "SIGHUP" && exit.signal !== "SIGPIPE") return true;
  if (exit.code === null || exit.code === 0) return false;
  return exit.code !== EXIT_STARTUP_REFUSED;
}

export type CheckStatus = "PASS" | "WARN" | "FAIL" | "INFO";
export interface Check { id: string; status: CheckStatus; detail: string }

function fileMode(path: string): { ok: boolean; detail: string } {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return { ok: false, detail: "é um link simbólico" };
    if (!info.isFile()) return { ok: false, detail: "não é um arquivo regular" };
    if (info.uid !== process.getuid?.()) return { ok: false, detail: "dono diferente do usuário atual" };
    if ((info.mode & 0o077) !== 0) return { ok: false, detail: `permissões ${(info.mode & 0o777).toString(8)} (exigido 600)` };
    return { ok: true, detail: "600, dono correto" };
  } catch { return { ok: false, detail: "ausente" }; }
}
async function portBusy(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (busy: boolean) => { socket.destroy(); resolve(busy); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

/**
 * Read-only diagnosis: files and permissions, configuration, executables, ownership of the runtime database, port and
 * service state. Never prints the credential (only whether the file is valid) and never opens the database.
 */
export async function doctor(options: { env: Record<string, string | undefined>; run: Runner; root?: string }): Promise<{ checks: Check[]; port: number | null; state: ServiceState }> {
  const root = options.root ?? repoRoot();
  const checks: Check[] = [];
  const add = (id: string, status: CheckStatus, detail: string) => checks.push({ id, status, detail });
  const paths = servicePaths(options.env);
  const state = await serviceState(options.run);
  add("service_state", "INFO", `${state.active}/${state.sub}; habilitado: ${state.enabled}; reinícios: ${state.restarts ?? "?"}; último resultado: ${state.result}` +
    (state.exitStatus ? `; status de saída ${state.exitStatus}${state.exitStatus === EXIT_STARTUP_REFUSED ? " (início recusado: veja os logs)" : ""}` : ""));

  let unitText: string | null = null;
  try { unitText = readFileSync(paths.unitFile, "utf8"); } catch { /* absent */ }
  let expected: string | null = null;
  try { expected = renderUnit(root, paths.envFile); } catch (error) { add("unit", "FAIL", `caminho do repositório não pode ir para a unit (${safeCode(error)})`); }
  if (expected !== null) add("unit", unitText === null ? "FAIL" : unitText === expected ? "PASS" : "WARN",
    unitText === null ? `ausente: ${paths.unitFile} (rode ./scripts/cockpit service install)` : unitText === expected ? paths.unitFile : "difere da gerada por este checkout: rode ./scripts/cockpit service install");
  // The file must be the one the user manager actually loads (an XDG_CONFIG_HOME different from the manager's would hide it).
  if (unitText !== null) add("unit_loaded", state.fragment === paths.unitFile ? "PASS" : state.fragment ? "FAIL" : "WARN",
    state.fragment === paths.unitFile ? "carregada pelo systemd do usuário"
      : state.fragment ? `o systemd usa outra unit (${state.fragment}); start/restart iniciariam outra coisa`
      : "o systemd do usuário não carregou esta unit: rode systemctl --user daemon-reload ou confira se XDG_CONFIG_HOME do shell é o do gerenciador");

  const envMode = fileMode(paths.envFile);
  let values: Record<string, string> | null = null;
  if (!envMode.ok) add("env_file", "FAIL", `${paths.envFile}: ${envMode.detail}`);
  else {
    try { values = parseEnvFile(readFileSync(paths.envFile, "utf8")); add("env_file", "PASS", `${paths.envFile} (${envMode.detail})`); }
    catch (error) { add("env_file", "FAIL", `${paths.envFile}: ${safeCode(error)}`); }
  }
  const tokenPath = values?.COCKPIT_LOCAL_TOKEN_FILE ?? paths.tokenFile;
  try { readLocalCredentialFile(tokenPath); add("token_file", "PASS", `${tokenPath} (600, formato válido; conteúdo não exibido)`); }
  catch (error) { add("token_file", "FAIL", `${tokenPath}: ${safeCode(error)}`); }

  let settings: ReturnType<typeof config> | null = null;
  if (values) {
    try { settings = validateSettings(values); add("config", "PASS", `modo ${settings.source}, porta ${settings.port}, ${settings.allowedProjects.length} projeto(s), reservadas: ${settings.reservedVms.join(",") || "nenhuma"}`); }
    catch (error) { add("config", "FAIL", safeCode(error)); }
    const dirs = (values.PATH ?? "").split(":");
    const has = (name: string) => dirs.some(dir => { try { return statSync(join(dir, name)).isFile(); } catch { return false; } });
    const pinned = readFileSync(join(root, ".bun-version"), "utf8").trim();
    const bunOk = dirs.some(dir => { try { return statSync(join(dir, "bun")).isFile() && bunVersion(join(dir, "bun")) === pinned; } catch { return false; } }) || existsSync(join(root, "tools/runtime/node_modules/.bin/bun"));
    add("bun", bunOk ? "PASS" : "FAIL", bunOk ? `Bun ${pinned} encontrado` : `Bun ${pinned} ausente do PATH do serviço (rode ./scripts/cockpit service install de um shell onde \`bun --version\` = ${pinned})`);
    if (settings?.source === "host") add("msb", has("msb") ? "PASS" : "FAIL", has("msb") ? "msb no PATH do serviço" : "msb ausente do PATH do serviço");
  }
  const manager = await options.run(["systemctl", "--user", "show-environment"]);
  const inherited = manager.code === 0 && manager.stdout.split("\n").some(line => line.startsWith("COCKPIT_LOCAL_TOKEN="));
  add("manager_env", inherited ? "WARN" : "PASS", inherited ? "o gerenciador systemd do usuário tem COCKPIT_LOCAL_TOKEN (valor não exibido); a unit o descarta. Remova com: systemctl --user unset-environment COCKPIT_LOCAL_TOKEN"
    : "nenhuma credencial no ambiente do gerenciador");

  if (settings) {
    const holders = existsSync(settings.runtimeDatabasePath) ? procDatabaseHolders(settings.runtimeDatabasePath) : [];
    const foreign = (holders ?? []).filter(pid => pid !== state.mainPid);
    add("runtime_database", holders === null ? "WARN" : foreign.length ? "FAIL" : "PASS", holders === null ? "posse não verificável nesta plataforma"
      : foreign.length ? `em uso por outro processo (pid ${foreign.join(", ")}): outra instância do Cockpit usa este data/. Não force; encerre-a primeiro`
      : holders.length ? "em uso apenas por este serviço" : existsSync(settings.runtimeDatabasePath) ? "livre (histórico preservado)" : "ainda não criado");
    const busy = await portBusy(settings.port);
    const ours = state.active === "active";
    add("port", busy && !ours ? "FAIL" : "PASS", busy && !ours ? `127.0.0.1:${settings.port} já está ocupada por outro processo` : busy ? `127.0.0.1:${settings.port} servida por este serviço` : `127.0.0.1:${settings.port} livre`);
  }
  const linger = await options.run(["loginctl", "show-user", String(process.getuid?.() ?? ""), "--property=Linger"]);
  add("linger", "INFO", /Linger=yes/.test(linger.stdout) ? "linger ativo: o serviço pode rodar sem sessão aberta" : "sem linger: o serviço do usuário para quando você sai da sessão gráfica (opcional: loginctl enable-linger)");
  return { checks, port: settings?.port ?? null, state };
}

/** Checks that must pass before start/restart (the unit would otherwise fail with exit 78). */
export const BLOCKING_CHECKS = new Set(["unit", "unit_loaded", "env_file", "token_file", "config", "bun", "msb", "runtime_database", "port"]);

export function defaultRunner(): Runner {
  return async argv => {
    try {
      const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin",
        ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
        ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}), ...(process.env.HOME ? { HOME: process.env.HOME } : {}) } });
      const stdout = await new Response(child.stdout).text();
      return { code: await child.exited, stdout };
    } catch { return { code: 127, stdout: "" }; }
  };
}

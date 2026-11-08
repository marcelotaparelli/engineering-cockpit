import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHostVmList } from "./adapter.ts";
import { ClaudeCodeAdapter } from "./claude-adapter.ts";
import { assertClaudeTarget } from "./claude-protocol.ts";
import { assertArchHost, hostFacts, type HostFacts } from "./host.ts";
import { SafeError, safeCode, validProject, vmIdentity } from "./model.ts";
import type { MsbSpawn } from "./msb-transport.ts";
import { parseVmInventory } from "./parser.ts";
import { assertNoSymlinks } from "./paths.ts";
import { assertRuntime } from "./runtime.ts";

/**
 * E3 — preparation of the real browser homologation on Arch, as ONE explicit, read-only preflight followed (only if every
 * check passes) by a SEPARATE Cockpit instance scoped to the test VM's project:
 *  - its own port (default 8788), state directory (`data/e3-homologation/`) and local token: the running Cockpit (E0, port
 *    8787, `COCKPIT_ALLOWED_PROJECTS=cockpit-e0-test`, `data/`) is never stopped, signalled, reconfigured or read;
 *  - its ACL is exactly the test project; a different `COCKPIT_ALLOWED_PROJECTS` in the caller's environment is refused,
 *    never silently replaced;
 *  - the preflight sends no prompt: `msb list`, then `claude --version`, `--help` and `auth status` inside the test VM
 *    (the same probe the adapter runs), keeping only booleans/version. No VM is created, started or changed.
 * The report never carries the token, e-mail, organisation or any prompt/response content.
 */
export type E3CheckStatus = "PASS" | "FAIL" | "NOT_VERIFIED";
export const E3_CHECK_IDS = ["runtime", "host_consent", "acl", "project_dir", "target_running", "claude_cli", "port_free", "data_dir"] as const;
export type E3CheckId = typeof E3_CHECK_IDS[number];
export interface E3Check { id: E3CheckId; status: E3CheckStatus; reason: string | null; evidence?: Record<string, string | number | boolean | null> }
export interface E3Report {
  milestone: "E3-homologation-prepare"; source: "host" | "synthetic"; timestamp: string; ready: boolean;
  vm: string | null; project: string | null; port: number | null; data_dir: string | null; checks: E3Check[];
}
export interface E3Launch { env: Record<string, string>; url: string; token: string; tokenGenerated: boolean }
export interface E3PrepareOverrides {
  env?: Record<string, string | undefined>;
  facts?: HostFacts;
  readOutput?: () => Promise<string>;
  spawn?: MsbSpawn;
  /** true when something already accepts connections on 127.0.0.1:port. */
  portInUse?: (port: number) => Promise<boolean>;
  repoRoot?: string;
}

export const E3_DEFAULT_PORT = 8788;
/** The running E0 Cockpit's port: never reused, even if it happens to be free at preflight time. */
const RESERVED_PORTS = new Set([8787]);
const TOKEN = /^[a-f0-9]{64}$/;

async function portInUse(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open() {}, error() {} } });
    socket.end();
    return true;
  } catch { return false; }
}

async function isRealDirectory(path: string): Promise<boolean> {
  try { assertNoSymlinks(path); const info = await lstat(path); return info.isDirectory() && !info.isSymbolicLink(); } catch { return false; }
}

export async function prepareE3Homologation(overrides?: E3PrepareOverrides): Promise<{ report: E3Report; launch: E3Launch | null }> {
  const env = overrides?.env ?? process.env;
  const checks: E3Check[] = E3_CHECK_IDS.map(id => ({ id, status: "NOT_VERIFIED", reason: "not_exercised" }));
  const report: E3Report = { milestone: "E3-homologation-prepare", source: overrides ? "synthetic" : "host", timestamp: new Date().toISOString(),
    ready: false, vm: null, project: null, port: null, data_dir: null, checks };
  const set = (id: E3CheckId, status: E3CheckStatus, reason: string | null, evidence?: E3Check["evidence"]) =>
    Object.assign(checks.find(check => check.id === id)!, { status, reason, ...(evidence ? { evidence } : {}) });
  const done = () => ({ report, launch: null });

  try { assertRuntime(); set("runtime", "PASS", null); } catch (error) { set("runtime", "FAIL", safeCode(error)); return done(); }

  // Explicit authorization, Arch host, exclusive test VM. Nothing below runs without every gate.
  let vm: string; let project: string; let port: number;
  try {
    assertArchHost(env, overrides?.facts ?? hostFacts());
    if (env.COCKPIT_E3_CONFIRMED !== "yes") throw new SafeError("e3_confirmation_required");
    vm = env.COCKPIT_E3_VM ?? "";
    if (!vm) throw new SafeError("e3_target_required");
    assertClaudeTarget(vm); // refuses non-Claude VMs and claude-engineering-cockpit
    if (!/^claude-cockpit-e2[a-z0-9_-]*$/.test(vm)) throw new SafeError("e3_target_not_isolated");
    project = vmIdentity(vm).project;
    if (!validProject(project)) throw new SafeError("e3_target_invalid");
    const rawPort = env.COCKPIT_E3_PORT ?? String(E3_DEFAULT_PORT);
    if (!/^[1-9][0-9]{3,4}$/.test(rawPort) || Number(rawPort) > 65535) throw new SafeError("e3_port_invalid");
    port = Number(rawPort);
    if (RESERVED_PORTS.has(port)) throw new SafeError("e3_port_reserved");
    if (!env.COCKPIT_PROJECTS_BASE?.startsWith("/")) throw new SafeError("host_projects_base_required");
    report.vm = vm; report.project = project; report.port = port;
    set("host_consent", "PASS", null);
  } catch (error) { set("host_consent", "NOT_VERIFIED", safeCode(error)); return done(); }

  // The new instance's grant is exactly the test project. A different ACL in the caller's env is a mistake: refuse it.
  const requested = env.COCKPIT_ALLOWED_PROJECTS;
  if (requested !== undefined && requested !== project) {
    set("acl", "FAIL", "e3_acl_mismatch", { requested_projects: requested.split(",").length, expected: project });
    return done();
  }
  set("acl", "PASS", null, { allowed_projects: project, from_environment: requested !== undefined });

  const base = env.COCKPIT_PROJECTS_BASE!;
  if (!await isRealDirectory(join(base, project))) { set("project_dir", "FAIL", "e3_project_dir_missing", { project }); return done(); }
  set("project_dir", "PASS", null, { project });

  let discoveryVersion: string;
  try {
    const row = parseVmInventory(await (overrides?.readOutput ?? readHostVmList)()).vms.find(item => item.vm_name === vm);
    if (!row) throw new SafeError("e3_target_absent");
    if (row.provider !== "claude") throw new SafeError("e3_target_not_claude");
    if (row.state !== "running") throw new SafeError("e3_target_not_running");
    discoveryVersion = new Date().toISOString();
    set("target_running", "PASS", null);
  } catch (error) {
    const code = safeCode(error);
    set("target_running", code === "e3_target_absent" || code === "e3_target_not_running" ? "NOT_VERIFIED" : "FAIL", code);
    return done();
  }

  // Exactly the probe the Cockpit runs before a Claude session (version >= 2, required flags, logged in). No prompt.
  try {
    const adapter = new ClaudeCodeAdapter(overrides?.spawn ? { spawn: overrides.spawn } : {});
    const connection = await adapter.connect({ provider: "claude", projectId: project, vmName: vm, vmInstanceId: null, discoveryVersion });
    try {
      const identity = await connection.initialize();
      set("claude_cli", "PASS", null, { version: identity.serverVersion, logged_in: true, prompt_route_argv: "--permission-prompt-tool stdio" });
    } finally { await connection.close().catch(() => {}); }
  } catch (error) { set("claude_cli", "FAIL", safeCode(error)); return done(); }

  if (await (overrides?.portInUse ?? portInUse)(port)) { set("port_free", "FAIL", "e3_port_in_use", { port }); return done(); }
  set("port_free", "PASS", null, { port });

  const root = overrides?.repoRoot ?? fileURLToPath(new URL("..", import.meta.url));
  const dataDir = join(root, "data", "e3-homologation");
  try { assertNoSymlinks(dataDir); } catch (error) { set("data_dir", "FAIL", safeCode(error)); return done(); }
  report.data_dir = "data/e3-homologation";
  set("data_dir", "PASS", null, { reused: await isRealDirectory(dataDir) });

  // Never the running instance's COCKPIT_LOCAL_TOKEN: a fresh one per start, or an explicit COCKPIT_E3_LOCAL_TOKEN.
  const provided = env.COCKPIT_E3_LOCAL_TOKEN || undefined;
  if (provided !== undefined && !TOKEN.test(provided)) { set("data_dir", "FAIL", "local_credential_invalid"); return done(); }
  const token = provided ?? randomBytes(32).toString("hex");
  report.ready = true;
  // Only Cockpit settings are replaced; PATH/HOME etc. are kept so `msb` works exactly as for the running instance.
  const inherited = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string" && !entry[0].startsWith("COCKPIT_") && entry[0] !== "PORT"));
  return {
    report,
    launch: {
      url: `http://127.0.0.1:${port}`, token, tokenGenerated: provided === undefined,
      env: { ...inherited, COCKPIT_MODE: "host", COCKPIT_HOST_CONFIRMED: "yes", COCKPIT_PROJECTS_BASE: base, COCKPIT_ALLOWED_PROJECTS: project,
        COCKPIT_DATA_DIR: dataDir, PORT: String(port), COCKPIT_LOCAL_TOKEN: token },
    },
  };
}

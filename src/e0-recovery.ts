import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { readHostVmList } from "./adapter.ts";
import { config } from "./config.ts";
import { assertArchHost, hostFacts, type HostFacts } from "./host.ts";
import { SafeError, safeCode } from "./model.ts";
import { parseVmList } from "./parser.ts";
import { assertRuntime } from "./runtime.ts";

/**
 * E0 / D7: restart recovery of a REAL in-flight run. Deterministic sequence:
 * preconditions → start one test run → confirm it is active → SIGKILL only the identified Cockpit →
 * restart it with the identical command/cwd/environment → run is `unknown` (process_restarted) → reconcile without resending.
 * Evidence contains status words and counters only: never the token, prompt, ids, paths or content.
 */
export const TARGET_VM = "codex-cockpit-e0-test";
export const TARGET_PROJECT = "cockpit-e0-test";
export type Verdict = "PASS" | "FAIL";
export interface Check { step: string; ok: boolean; detail?: string }
export interface RecoveryReport { milestone: "E0-D7"; source: "host" | "synthetic"; timestamp: string; overall: Verdict; reason: string | null; checks: Check[]; observed: Record<string, string | number | boolean | null> }

export interface ServerProcess { pid: number; argv: string[]; cwd: string; env: Record<string, string> }
export interface ProcessControl {
  /** Exactly the processes listening on 127.0.0.1:port. */
  listening(port: number): Promise<number[]>;
  inspect(pid: number): Promise<ServerProcess>;
  kill(pid: number): Promise<void>;
  alive(pid: number): Promise<boolean>;
  spawn(info: ServerProcess): Promise<void>;
}
export interface RuntimeProbe { activeRuns: number; sessions: number; runs: number }
export interface RecoveryDeps {
  env: Record<string, string | undefined>;
  facts: HostFacts;
  root: string;
  synthetic?: boolean;
  readVmList: () => Promise<string>;
  fetch: typeof fetch;
  proc: ProcessControl;
  /** Read-only look at the runtime DB; may throw when unreadable. */
  probeRuntime: (path: string) => RuntimeProbe;
  readToken: (path: string) => { token: string; mode: number; owned: boolean };
  sleep: (ms: number) => Promise<void>;
  timeouts: { activeMs: number; unknownMs: number; restartMs: number; settleMs: number };
}

const ACTIVE = new Set(["prepared", "dispatching", "running", "awaiting_approval"]);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

class Client {
  #cookie = ""; #proof = ""; #csrf = "";
  constructor(private readonly base: string, private readonly doFetch: typeof fetch, private readonly token: string) {}
  async login(): Promise<void> {
    const response = await this.doFetch(this.base + "/api/auth/login", { method: "POST", headers: { Origin: this.base, "Content-Type": "application/json" }, body: JSON.stringify({ credential: this.token }) });
    if (response.status !== 200) throw new SafeError("login_failed");
    const body = await response.json() as { proof: string; csrf: string };
    this.#cookie = (response.headers.get("set-cookie") ?? "").split(";")[0]!; this.#proof = body.proof; this.#csrf = body.csrf;
  }
  async get<T>(path: string): Promise<{ status: number; body: T }> {
    const response = await this.doFetch(this.base + path, { headers: { Cookie: this.#cookie, "X-Session-Proof": this.#proof } });
    return { status: response.status, body: await response.json() as T };
  }
  async post<T>(path: string, body: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    const response = await this.doFetch(this.base + path, { method: "POST", body: JSON.stringify(body), headers: { Cookie: this.#cookie, "X-Session-Proof": this.#proof,
      "X-CSRF-Token": this.#csrf, "X-Request-Nonce": crypto.randomUUID().replaceAll("-", "") + "xx", Origin: this.base, "Content-Type": "application/json", ...extra } });
    return { status: response.status, body: await response.json() as T };
  }
}
interface RunView { status: string; provider_bound: boolean; reason_code: string | null }

export async function runRecoveryTest(deps: RecoveryDeps): Promise<RecoveryReport> {
  const report: RecoveryReport = { milestone: "E0-D7", source: deps.synthetic ? "synthetic" : "host", timestamp: new Date().toISOString(), overall: "FAIL", reason: null, checks: [], observed: {} };
  const ok = (step: string, detail?: string) => { report.checks.push({ step, ok: true, ...(detail ? { detail } : {}) }); };
  const fail = (step: string, code: string): never => { report.checks.push({ step, ok: false, detail: code }); throw new SafeError(code); };
  const env = deps.env;
  let killed: ServerProcess | null = null;
  let restarted = false;
  let client: Client | undefined;
  let runId: string | undefined;
  let tokenHash = "";
  try {
    // ---- 1. preconditions (nothing is touched yet)
    try { if (!deps.synthetic) assertRuntime(); } catch (error) { fail("runtime", safeCode(error)); }
    try { assertArchHost(env, deps.facts); } catch (error) { fail("arch_host", safeCode(error)); }
    ok("arch_host");
    if (env.COCKPIT_E0_RECOVERY_CONFIRMED !== "yes") fail("consent", "recovery_confirmation_required");
    ok("consent");
    if (!/^[1-9][0-9]{0,4}$/.test(env.COCKPIT_PORT ?? "")) fail("port", "recovery_port_required");
    const port = Number(env.COCKPIT_PORT);
    if (!env.COCKPIT_TOKEN_FILE?.startsWith("/")) fail("token_file", "recovery_token_file_required");
    let token: string;
    try {
      const file = deps.readToken(env.COCKPIT_TOKEN_FILE!);
      if ((file.mode & 0o077) !== 0 || !file.owned) fail("token_file", "token_file_permissions");
      if (!/^[0-9a-f]{64}$/.test(file.token)) fail("token_file", "token_file_format");
      token = file.token;
    } catch (error) { if (error instanceof SafeError) throw error; return fail("token_file", "token_file_unreadable"); }
    tokenHash = sha(token);
    ok("token_file", "mode_0600");

    const pids = await deps.proc.listening(port);
    if (pids.length !== 1) fail("identify_cockpit", pids.length === 0 ? "cockpit_not_listening" : "cockpit_ambiguous");
    const info = await deps.proc.inspect(pids[0]!);
    const isBun = /(^|\/)bun$/.test(info.argv[0] ?? "");
    const entry = info.argv.some(arg => arg === "src/index.ts" || arg.endsWith("/src/index.ts"));
    if (!isBun || !entry) fail("identify_cockpit", "cockpit_command_mismatch");
    if (info.cwd !== deps.root) fail("identify_cockpit", "cockpit_cwd_mismatch");
    if (info.env.COCKPIT_MODE !== "host" || info.env.COCKPIT_HOST_CONFIRMED !== "yes") fail("identify_cockpit", "cockpit_not_host_mode");
    if (info.env.COCKPIT_ALLOWED_PROJECTS !== TARGET_PROJECT) fail("identify_cockpit", "cockpit_projects_not_isolated");
    if (info.env.COCKPIT_LOCAL_TOKEN !== token) fail("identify_cockpit", "cockpit_token_mismatch");
    if (Number(info.env.PORT) !== port) fail("identify_cockpit", "cockpit_port_mismatch");
    ok("identify_cockpit", "command_cwd_env_match");

    const vmsBefore = parseVmList(await deps.readVmList());
    const target = vmsBefore.find(vm => vm.vm_name === TARGET_VM);
    if (!target || target.state !== "running") fail("target_vm", "target_vm_not_running");
    const othersBefore = JSON.stringify(vmsBefore.filter(vm => vm.vm_name !== TARGET_VM).map(vm => [vm.vm_name, vm.state]).sort());
    ok("target_vm", `others=${vmsBefore.length - 1}`);

    const base = `http://127.0.0.1:${port}`;
    client = new Client(base, deps.fetch, token);
    try { await client.login(); } catch { fail("login", "login_failed"); }
    const dashboard = (await client.get<{ vms: Array<{ vm_name: string; runnable: boolean }>; counts: Record<string, number> }>("/api/dashboard")).body;
    const runnable = dashboard.vms.filter(vm => vm.runnable).map(vm => vm.vm_name);
    if (runnable.length !== 1 || runnable[0] !== TARGET_VM) fail("isolation", "other_vms_runnable");
    ok("isolation", "only_target_runnable");

    const settings = config(info.env);
    let before: RuntimeProbe | null = null;
    try { before = deps.probeRuntime(settings.runtimeDatabasePath); } catch { before = null; }
    if (before) {
      if (before.activeRuns !== 0) fail("no_active_runs", "active_runs_present");
      ok("no_active_runs", "runtime_db");
    } else {
      // Fallback: the API only shows the granted project, which the process environment proved to be the test project.
      if ((dashboard.counts.working ?? 0) !== 0 || (dashboard.counts.awaiting_approval ?? 0) !== 0) fail("no_active_runs", "active_runs_present");
      ok("no_active_runs", "api_only");
    }
    report.observed.activity_check = before ? "runtime_db" : "api_only";

    // ---- 2. start exactly one test run
    const nonce = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const opened = await client.post<{ session_id: string }>("/api/sessions", { vm_name: TARGET_VM, mode: "new" });
    if (opened.status !== 201) fail("open_session", `open_session_${opened.status}`);
    const sessionId = opened.body.session_id;
    const prompt = `[E0-D7 ${nonce}] Run exactly one slow shell command: sleep 300. Do nothing else. Afterwards reply with the single word ok.`;
    const key = `d7-${crypto.randomUUID()}`;
    const started = await client.post<{ run_id: string }>(`/api/sessions/${sessionId}/runs`, { prompt }, { "Idempotency-Key": key });
    if (started.status !== 202) fail("start_run", `start_run_${started.status}`);
    runId = started.body.run_id;
    ok("start_run", "prompt_sent_once");

    // ---- 3. confirm it is really active on the provider before touching the server
    let view = (await client.get<RunView>(`/api/runs/${runId}`)).body;
    for (const deadline = Date.now() + deps.timeouts.activeMs; !(ACTIVE.has(view.status) && view.provider_bound && view.status !== "prepared" && view.status !== "dispatching"); ) {
      if (!ACTIVE.has(view.status)) fail("run_active", `run_ended_early_${view.status}`);
      if (Date.now() > deadline) fail("run_active", "run_not_active_in_time");
      await deps.sleep(250);
      view = (await client.get<RunView>(`/api/runs/${runId}`)).body;
    }
    report.observed.status_before_kill = view.status;
    ok("run_active", view.status);

    // ---- 4. kill ONLY the identified Cockpit (SIGKILL = crash, no graceful close) and restart it identically
    killed = info;
    await deps.proc.kill(info.pid);
    for (const deadline = Date.now() + 5000; await deps.proc.alive(info.pid); ) {
      if (Date.now() > deadline) fail("kill", "cockpit_did_not_exit");
      await deps.sleep(100);
    }
    ok("kill", "cockpit_stopped");
    await deps.proc.spawn(info);
    for (const deadline = Date.now() + deps.timeouts.restartMs; ; ) {
      const up = await deps.fetch(base + "/api/health").then(r => r.status === 200, () => false);
      if (up) break;
      if (Date.now() > deadline) fail("restart", "cockpit_not_back");
      await deps.sleep(250);
    }
    restarted = true;
    const newPids = await deps.proc.listening(port);
    if (newPids.length !== 1 || newPids[0] === info.pid) fail("restart", "cockpit_restart_unverified");
    ok("restart", "same_command_cwd_env");

    // ---- 5. recovery: unknown, never resent
    client = new Client(base, deps.fetch, token);
    try { await client.login(); } catch { fail("relogin", "token_not_accepted_after_restart"); }
    ok("relogin", "same_token_accepted");
    view = (await client.get<RunView>(`/api/runs/${runId}`)).body;
    for (const deadline = Date.now() + deps.timeouts.unknownMs; view.status !== "unknown"; ) {
      if (Date.now() > deadline) fail("unknown_after_restart", `status_${view.status}`);
      await deps.sleep(250);
      view = (await client.get<RunView>(`/api/runs/${runId}`)).body;
    }
    if (view.reason_code !== "process_restarted") fail("unknown_after_restart", `reason_${view.reason_code ?? "none"}`);
    report.observed.status_after_restart = view.status;
    report.observed.reason_after_restart = view.reason_code;
    ok("unknown_after_restart", "process_restarted");

    const reconciled = await client.post<RunView>(`/api/runs/${runId}/reconcile`, {});
    if (reconciled.status !== 200) fail("reconcile", `reconcile_${reconciled.status}`);
    report.observed.status_after_reconcile = reconciled.body.status;
    if (reconciled.body.status === "unknown") fail("reconcile", "reconcile_unresolved");
    ok("reconcile", reconciled.body.status);

    // ---- 6. the prompt reached the provider exactly once
    const history = await client.get<{ items?: Array<{ kind: string; text: string | null }> }>(`/api/sessions/${sessionId}/history`);
    if (history.status === 200 && history.body.items) {
      const copies = history.body.items.filter(item => item.kind === "user_message" && (item.text ?? "").includes(`E0-D7 ${nonce}`)).length;
      report.observed.prompt_copies = copies;
      // An in-progress turn may not be listed yet (0 is not proof); more than one is a resend.
      if (copies > 1) fail("prompt_once", `prompt_copies_${copies}`);
      ok("prompt_once", `copies_${copies}`);
    } else { ok("prompt_once", "history_unavailable_not_asserted"); }
    const sessionRuns = (await client.get<{ runs: unknown[] }>(`/api/sessions/${sessionId}`)).body.runs.length;
    report.observed.runs_in_session = sessionRuns;
    if (sessionRuns !== 1) fail("no_second_run", `runs_${sessionRuns}`);
    ok("no_second_run");

    // ---- 7. integrity: token, DB and infrastructure unchanged
    if (sha(deps.readToken(env.COCKPIT_TOKEN_FILE!).token) !== tokenHash) fail("integrity", "token_file_changed");
    if (before) {
      const after = deps.probeRuntime(settings.runtimeDatabasePath);
      if (after.sessions < before.sessions + 1 || after.runs !== before.runs + 1) fail("integrity", "runtime_db_unexpected");
      report.observed.db_runs_added = after.runs - before.runs;
    }
    const vmsAfter = parseVmList(await deps.readVmList());
    if (JSON.stringify(vmsAfter.filter(vm => vm.vm_name !== TARGET_VM).map(vm => [vm.vm_name, vm.state]).sort()) !== othersBefore) fail("integrity", "other_vms_changed");
    ok("integrity", "token_db_other_vms_unchanged");
    report.overall = "PASS";
  } catch (error) { report.reason = safeCode(error); }
  finally {
    // Never leave the operator without a Cockpit, and never leave the test command running on the VM.
    if (killed && !restarted) {
      try { await deps.proc.spawn(killed); report.observed.emergency_restart = true; } catch { report.observed.emergency_restart = false; if (!report.reason) report.reason = "restart_failed"; report.overall = "FAIL"; }
    }
    if (client && runId) {
      try {
        const current = (await client.get<RunView>(`/api/runs/${runId}`)).body;
        if (ACTIVE.has(current.status)) {
          await client.post(`/api/runs/${runId}/interrupt`, {});
          for (const deadline = Date.now() + deps.timeouts.settleMs; Date.now() < deadline; await deps.sleep(250)) {
            if (!ACTIVE.has((await client.get<RunView>(`/api/runs/${runId}`)).body.status)) break;
          }
        }
        report.observed.final_status = (await client.get<RunView>(`/api/runs/${runId}`)).body.status;
      } catch { report.observed.final_status = "not_confirmed"; }
    }
  }
  return report;
}

// ------------------------------------------------------------------ real host wiring
function readProcEnv(pid: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
    const index = entry.indexOf("=");
    if (index > 0) out[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return out;
}
export function realProcessControl(root: string): ProcessControl {
  const run = async (argv: string[]): Promise<string> => {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const text = await new Response(child.stdout).text();
    await child.exited;
    return text;
  };
  return {
    async listening(port) {
      const text = await run(["ss", "-Htlnp", `sport = :${port}`]);
      return [...new Set([...text.matchAll(/pid=(\d+)/g)].map(match => Number(match[1])))];
    },
    async inspect(pid) {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      return { pid, argv, cwd: realpathSync(readlinkSync(`/proc/${pid}/cwd`)), env: readProcEnv(pid) };
    },
    async kill(pid) { process.kill(pid, "SIGKILL"); },
    async alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } },
    async spawn(info) {
      const fd = openSync(join(realpathSync(info.cwd), ".cache", "e0-cockpit-restart.log"), "a", 0o600);
      try {
        const child = Bun.spawn(["setsid", ...info.argv], { cwd: info.cwd, env: info.env, stdin: "ignore", stdout: fd, stderr: fd });
        child.unref();
      } finally { closeSync(fd); }
    },
  };
}
export function realRecoveryDeps(root: string, env: Record<string, string | undefined> = process.env): RecoveryDeps {
  return {
    env, facts: hostFacts(), root: realpathSync(root), readVmList: () => readHostVmList(), fetch, proc: realProcessControl(root),
    probeRuntime(path) {
      const db = new Database(path, { readonly: true });
      try {
        const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
        return { activeRuns: count("SELECT COUNT(*) AS n FROM runs WHERE status IN ('prepared','dispatching','running','awaiting_approval')"), sessions: count("SELECT COUNT(*) AS n FROM sessions"), runs: count("SELECT COUNT(*) AS n FROM runs") };
      } finally { db.close(); }
    },
    readToken(path) {
      const stat = statSync(path);
      return { token: readFileSync(path, "utf8").trim(), mode: stat.mode & 0o777, owned: stat.uid === process.getuid!() && stat.isFile() };
    },
    sleep: ms => Bun.sleep(ms),
    timeouts: { activeMs: 90_000, unknownMs: 15_000, restartMs: 30_000, settleMs: 30_000 },
  };
}

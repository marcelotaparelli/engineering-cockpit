import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SafeError, safeCode, vmIdentity } from "./model.ts";
import { defaultRunner, isLink, newToken, portBusy, renderEnvFile, renderUnit, repoRoot, SAFE_PATH, servicePath, type Runner } from "./service.ts";

/**
 * F1-D — real systemd smoke on the Arch host (operator-run; never on the development VM).
 *
 * Proves that the Cockpit, started by systemd from the SAME unit template as the service (NoNewPrivileges=yes, KillMode=process,
 * Restart policy, UMask), can operate Microsandbox: `msb list` (discovery) and `msb exec` (Codex App Server initialize +
 * thread/list, read-only: no prompt, no quota). It also checks, under real systemd, crash → restart → orphan ledger, orderly
 * stop and that a refused start (exit 78) is not restarted.
 *
 * Isolation: a RUNTIME unit `engineering-cockpit-f1-smoke.service` in $XDG_RUNTIME_DIR/systemd/user (gone at reboot), its own
 * port, data directory and generated credential under .cache/. It never reads or writes ~/.config/engineering-cockpit, the
 * installed service, the operator's data/ or credentials, and never stops another Cockpit. The only processes it ever signals
 * are those inside its own unit's cgroup. Everything it created is removed at the end, PASS or FAIL.
 */
export const SMOKE_UNIT = "engineering-cockpit-f1-smoke.service";
export const SMOKE_CHECK_IDS = ["preconditions", "unit_loaded", "start", "no_new_privileges", "credential_file", "msb_list", "msb_exec",
  "crash_restart", "orphan_ledger", "msb_exec_after_restart", "orderly_stop", "refused_start_not_restarted", "journal_clean", "cleanup"] as const;
/**
 * F1-P1 proof (opt-in, quota): the crash happens while a REAL turn is in flight, so a real `msb exec` child can survive it and the
 * orphan ledger is exercised for real under systemd. Needs COCKPIT_SMOKE_ORPHAN_PROOF=yes AND COCKPIT_SMOKE_QUOTA_CONFIRMED=yes.
 */
export const SMOKE_PROOF_CHECK_IDS = ["orphan_turn_started", "run_unknown_after_crash", "orphan_blocks_send", "orphan_released"] as const;
/** The only prompt the proof sends (one turn, no tools): long enough to outlive the SIGKILL, small enough to cost little quota. */
export const PROOF_PROMPT = "Teste automatizado F1-P1, sem usar ferramentas: escreva 300 linhas numeradas, cada uma com uma frase curta sobre o mar.";
/** Sent only to PROVE it is refused while an orphan is alive; if it were accepted, it is as harmless as a prompt can be. */
export const PROOF_PROBE_PROMPT = "Responda apenas: ok.";
type CheckId = typeof SMOKE_CHECK_IDS[number] | typeof SMOKE_PROOF_CHECK_IDS[number];
type Status = "PASS" | "FAIL" | "NOT_VERIFIED";
export interface SmokeCheck { id: CheckId; status: Status; reason: string | null; evidence?: Record<string, unknown> }
export interface SmokeReport { milestone: "F1-D-systemd-smoke"; timestamp: string; overall: Status; unit: string; vm: string | null; checks: SmokeCheck[] }

export interface SmokeOptions {
  env?: Record<string, string | undefined>;
  run?: Runner;
  root?: string;
  timeoutsMs?: { start: number; restart: number; settle: number };
  /** Registers the interrupt handler (SIGINT/SIGTERM/SIGHUP); returns the unregister function. Injectable for tests. */
  onInterrupt?: (handler: () => Promise<void>) => () => void;
  /** Reads /proc and cgroup files; injectable for tests. */
  proc?: { mainNoNewPrivs(pid: number): boolean | null; cgroupPids(controlGroup: string): number[]; isMsb(pid: number): boolean; alive(pid: number): boolean;
    /** True only if the process is, right now, a member of exactly this cgroup (cgroup v2 `0::<path>`). */
    inGroup(pid: number, controlGroup: string): boolean };
}

const realProc: NonNullable<SmokeOptions["proc"]> = {
  mainNoNewPrivs: pid => { try { const m = /^NoNewPrivs:\s*(\d)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8")); return m ? m[1] === "1" : null; } catch { return null; } },
  cgroupPids: group => {
    if (!group.startsWith("/") || group.split("/").includes("..")) return [];
    try { return readFileSync(`/sys/fs/cgroup${group}/cgroup.procs`, "utf8").split("\n").filter(Boolean).map(Number).filter(Number.isSafeInteger); } catch { return []; }
  },
  isMsb: pid => {
    try { const argv0 = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] ?? ""; return basename(argv0) === "msb" || basename(readlinkSync(`/proc/${pid}/exe`)) === "msb"; }
    catch { return false; }
  },
  alive: pid => existsSync(`/proc/${pid}`),
  inGroup: (pid, group) => {
    if (!group) return false;
    try { return readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").some(line => line === `0::${group}`); } catch { return false; }
  },
};

const realOnInterrupt: NonNullable<SmokeOptions["onInterrupt"]> = handler => {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let fired = false;
  const listener = () => { if (fired) return; fired = true; void handler().finally(() => process.exit(130)); };
  for (const signal of signals) process.on(signal, listener);
  return () => { for (const signal of signals) process.off(signal, listener); };
};

export async function runSystemdSmoke(options: SmokeOptions = {}): Promise<SmokeReport> {
  const env = options.env ?? process.env;
  const onInterrupt = options.onInterrupt ?? realOnInterrupt;
  const run = options.run ?? defaultRunner();
  const root = options.root ?? repoRoot();
  const proc = options.proc ?? realProc;
  const timeouts = options.timeoutsMs ?? { start: 20_000, restart: 30_000, settle: 8_000 };
  const proof = env.COCKPIT_SMOKE_ORPHAN_PROOF === "yes";
  const report: SmokeReport = { milestone: "F1-D-systemd-smoke", timestamp: new Date().toISOString(), overall: "FAIL", unit: SMOKE_UNIT, vm: null,
    checks: [...SMOKE_CHECK_IDS, ...(proof ? SMOKE_PROOF_CHECK_IDS : [])].map(id => ({ id, status: "NOT_VERIFIED", reason: "not_exercised" })) };
  const set = (id: CheckId, status: Status, reason: string | null = null, evidence?: Record<string, unknown>) =>
    Object.assign(report.checks.find(check => check.id === id)!, { status, reason, ...(evidence ? { evidence } : {}) });
  const systemctl = (...args: string[]) => run(["systemctl", "--user", ...args]);
  const show = async (...props: string[]) => {
    const out = await systemctl("show", SMOKE_UNIT, `--property=${props.join(",")}`);
    return Object.fromEntries(out.stdout.split("\n").filter(line => line.includes("=")).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  };
  let unitFile: string | null = null;
  let workDir: string | null = null;
  let created = false;
  const ours = new Set<number>(); // msb processes seen in OUR unit's cgroup (the only ones this smoke may signal)
  let unitGroup = ""; // the smoke unit's cgroup; every signal re-verifies membership (no PID-reuse accident)

  // ---------------------------------------------------------------- preconditions (nothing is written before they pass)
  let vm = "", project = "", port = 0, runtimeDir = "", path = "";
  try {
    if (process.platform !== "linux") throw new SafeError("linux_required");
    if (env.COCKPIT_F1_SMOKE_CONFIRMED !== "yes") throw new SafeError("confirmation_required");
    if (proof && env.COCKPIT_SMOKE_QUOTA_CONFIRMED !== "yes") throw new SafeError("quota_confirmation_required");
    vm = env.COCKPIT_SMOKE_VM ?? "";
    const identity = (() => { try { return vmIdentity(vm); } catch { throw new SafeError("smoke_vm_invalid"); } })();
    if (identity.provider !== "codex") throw new SafeError("smoke_vm_must_be_codex");
    project = identity.project;
    report.vm = vm;
    if (!env.COCKPIT_PROJECTS_BASE?.startsWith("/") || !SAFE_PATH.test(env.COCKPIT_PROJECTS_BASE)) throw new SafeError("host_projects_base_required");
    runtimeDir = env.XDG_RUNTIME_DIR ?? "";
    if (!runtimeDir.startsWith("/") || !SAFE_PATH.test(runtimeDir)) throw new SafeError("xdg_runtime_dir_required");
    if ((await systemctl("show-environment")).code !== 0) throw new SafeError("systemd_user_manager_unavailable");
    path = servicePath(env, "host", root); // pinned Bun and msb from this shell, as `service install` would
    unitFile = join(runtimeDir, "systemd/user", SMOKE_UNIT);
    let leftoverCleaned = false;
    if (existsSync(unitFile) || isLink(unitFile)) {
      // A unit with our name is already there. If systemd loads exactly THIS runtime file, it is the leftover of an interrupted
      // smoke (nothing else writes that name there): stop it, end its cgroup, remove it. Anything else is not ours: refuse.
      const loadedPath = (await systemctl("show", SMOKE_UNIT, "--property=FragmentPath")).stdout.split("\n").find(line => line.startsWith("FragmentPath="))?.slice("FragmentPath=".length) ?? "";
      if (isLink(unitFile) || loadedPath !== unitFile) throw new SafeError("smoke_unit_already_present");
      await systemctl("stop", SMOKE_UNIT);
      await systemctl("kill", "--kill-whom=all", "--signal=SIGKILL", SMOKE_UNIT);
      await systemctl("reset-failed", SMOKE_UNIT);
      rmSync(unitFile, { force: true });
      if ((await systemctl("daemon-reload")).code !== 0) throw new SafeError("daemon_reload_failed");
      leftoverCleaned = true;
    }
    port = 0;
    for (let attempt = 0; attempt < 20 && port === 0; attempt++) { const candidate = 21000 + Math.floor(Math.random() * 8000); if (!(await portBusy(candidate))) port = candidate; }
    if (port === 0) throw new SafeError("no_free_port");
    set("preconditions", "PASS", null, { vm, port, leftover_cleaned: leftoverCleaned });
  } catch (error) {
    set("preconditions", "NOT_VERIFIED", safeCode(error));
    report.overall = "NOT_VERIFIED";
    return report;
  }

  const token = newToken();
  let current: CheckId = "unit_loaded";
  let cleaned = false;
  /** Idempotent. Stops the unit, ends everything in ITS cgroup (systemd addresses the cgroup, never a PID), verifies, removes files. */
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    const problems: string[] = [];
    if (created) {
      if ((await systemctl("stop", SMOKE_UNIT)).code !== 0) problems.push("stop");
      await systemctl("kill", "--kill-whom=all", "--signal=SIGKILL", SMOKE_UNIT);
      await systemctl("reset-failed", SMOKE_UNIT);
      const state = (await show("ActiveState")).ActiveState ?? "unknown";
      if (state !== "inactive" && state !== "failed") problems.push(`unit_${state}`);
      if (unitGroup && proc.cgroupPids(unitGroup).length) problems.push("cgroup_not_empty");
      try { rmSync(unitFile!, { force: true }); } catch { problems.push("unit_file"); }
      if ((await systemctl("daemon-reload")).code !== 0) problems.push("daemon_reload");
    }
    if (workDir) { try { rmSync(workDir, { recursive: true, force: true }); } catch { problems.push("work_dir"); } }
    set("cleanup", problems.length ? "FAIL" : "PASS", problems.join(",") || null);
  };
  const unregister = onInterrupt(async () => { set(current, "FAIL", "interrupted"); await cleanup(); });
  try {
    // ---------------------------------------------------------------- isolated state + runtime unit from the real template
    const base = join(root, ".cache", "f1-systemd-smoke");
    mkdirSync(base, { recursive: true, mode: 0o700 }); chmodSync(base, 0o700);
    workDir = join(base, `run-${Date.now()}-${randomBytes(4).toString("hex")}`);
    mkdirSync(workDir, { mode: 0o700 }); chmodSync(workDir, 0o700);
    const tokenFile = join(workDir, "token");
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: "wx" });
    const envFile = join(workDir, "cockpit.env");
    writeFileSync(envFile, renderEnvFile({ COCKPIT_MODE: "host", COCKPIT_HOST_CONFIRMED: "yes", COCKPIT_PROJECTS_BASE: env.COCKPIT_PROJECTS_BASE!,
      COCKPIT_ALLOWED_PROJECTS: project, PORT: String(port), COCKPIT_DATA_DIR: join(workDir, "data"), COCKPIT_LOCAL_TOKEN_FILE: tokenFile, PATH: path,
      ...(env.LANG && /^[A-Za-z0-9._@-]+$/.test(env.LANG) ? { LANG: env.LANG } : {}) }), { mode: 0o600, flag: "wx" });
    mkdirSync(join(runtimeDir, "systemd/user"), { recursive: true, mode: 0o700 });
    writeFileSync(unitFile, renderUnit(root, envFile), { mode: 0o644, flag: "wx" });
    created = true;
    if ((await systemctl("daemon-reload")).code !== 0) throw new SafeError("daemon_reload_failed");
    const loaded = await show("FragmentPath", "NoNewPrivileges", "KillMode", "Restart", "RestartPreventExitStatus");
    if (loaded.FragmentPath !== unitFile) throw new SafeError("smoke_unit_not_loaded");
    set("unit_loaded", "PASS", null, { no_new_privileges: loaded.NoNewPrivileges, kill_mode: loaded.KillMode, restart: loaded.Restart, prevent: loaded.RestartPreventExitStatus });

    const url = `http://127.0.0.1:${port}/`;
    const healthy = async (ms: number) => { for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(300)) { try { if ((await fetch(url + "api/health")).ok) return true; } catch { /* not yet */ } } return false; };
    const client = new SmokeClient(url, token);
    const threads = async () => { const r = await client.get(`api/vms/${encodeURIComponent(vm)}/threads`); return { status: r.status, code: (r.body as { error?: { code?: string } }).error?.code ?? null }; };
    const controlGroup = async () => { const group = (await show("ControlGroup")).ControlGroup ?? ""; if (group.endsWith(`/${SMOKE_UNIT}`)) unitGroup = group; return group; };
    const remember = async () => { const group = await controlGroup(); for (const pid of proc.cgroupPids(group)) if (proc.isMsb(pid)) ours.add(pid); };

    // ---------------------------------------------------------------- start under systemd
    current = "start";
    if ((await systemctl("start", SMOKE_UNIT)).code !== 0 || !(await healthy(timeouts.start))) throw new SafeError("service_not_healthy");
    const first = await show("MainPID", "ActiveState");
    set("start", "PASS", null, { active: first.ActiveState });

    current = "no_new_privileges";
    const nnp = proc.mainNoNewPrivs(Number(first.MainPID));
    if (nnp !== true) throw new SafeError(nnp === false ? "no_new_privs_not_set" : "no_new_privs_unreadable");
    set("no_new_privileges", "PASS", null, { proc_status_NoNewPrivs: 1 });

    current = "credential_file";
    if (await client.login() !== 200) throw new SafeError("login_failed");
    set("credential_file", "PASS");

    // ---------------------------------------------------------------- msb list / msb exec under NoNewPrivileges
    current = "msb_list";
    const dashboard = (await client.get("api/dashboard")).body as { discovery_error: string | null; vms: Array<{ vm_name: string; vm_state: string }> };
    if (dashboard.discovery_error) throw new SafeError(`discovery_${dashboard.discovery_error}`);
    const seen = dashboard.vms.find(item => item.vm_name === vm);
    if (!seen) throw new SafeError("smoke_vm_not_listed");
    if (seen.vm_state !== "running") { set("msb_list", "PASS", null, { vm_state: seen.vm_state }); throw new SafeError("smoke_vm_not_running"); }
    set("msb_list", "PASS", null, { vm_state: "running" });

    current = "msb_exec";
    const listed = await threads();
    if (listed.status !== 200) throw new SafeError(`threads_${listed.code ?? listed.status}`);
    await remember();
    set("msb_exec", "PASS", null, { route: "GET /api/vms/:vm/threads (initialize + thread/list, read-only)", msb_children_in_unit: ours.size });

    // ---------------------------------------------------------------- F1-P1 (opt-in): a real turn is in flight when the Cockpit is killed
    let proofSession = ""; let proofRun = "";
    if (proof) {
      current = "orphan_turn_started";
      const created = await client.post("api/sessions", { vm_name: vm, mode: "new" });
      proofSession = (created.body as { session_id?: string }).session_id ?? "";
      if (created.status !== 201 || !proofSession) throw new SafeError(`proof_session_${(created.body as { error?: { code?: string } }).error?.code ?? created.status}`);
      const sent = await client.post(`api/sessions/${encodeURIComponent(proofSession)}/runs`, { prompt: PROOF_PROMPT }, { "Idempotency-Key": `f1p1-${randomBytes(12).toString("hex")}` });
      proofRun = (sent.body as { run_id?: string }).run_id ?? "";
      if (sent.status !== 202 || !proofRun) throw new SafeError(`proof_run_${(sent.body as { error?: { code?: string } }).error?.code ?? sent.status}`);
      let runStatus = "";
      for (const end = Date.now() + timeouts.start; Date.now() < end && runStatus !== "running" && runStatus !== "awaiting_approval"; await Bun.sleep(300)) {
        runStatus = ((await client.get(`api/runs/${encodeURIComponent(proofRun)}`)).body as { status?: string }).status ?? "";
        if (["completed", "failed", "interrupted", "unknown"].includes(runStatus)) break;
      }
      if (runStatus !== "running" && runStatus !== "awaiting_approval") throw new SafeError(`proof_turn_not_in_flight_${runStatus || "no_status"}`);
      await remember();
      set("orphan_turn_started", "PASS", null, { run_status: runStatus, msb_children_in_unit: ours.size, note: "one real prompt was sent to the smoke VM; it is the operator's quota spend" });
    }

    // ---------------------------------------------------------------- crash → systemd restart → orphan ledger
    current = "crash_restart";
    const before = await show("MainPID", "NRestarts");
    await systemctl("kill", "--signal=SIGKILL", "--kill-whom=main", SMOKE_UNIT);
    let after: Record<string, string> = {};
    for (const end = Date.now() + timeouts.restart; Date.now() < end; await Bun.sleep(500)) {
      after = await show("MainPID", "NRestarts", "ActiveState");
      if (after.ActiveState === "active" && after.MainPID !== "0" && after.MainPID !== before.MainPID && Number(after.NRestarts) > Number(before.NRestarts || "0")) break;
    }
    if (after.ActiveState !== "active" || after.MainPID === before.MainPID || !(await healthy(timeouts.start))) throw new SafeError("not_restarted_after_crash");
    set("crash_restart", "PASS", null, { restarts: Number(after.NRestarts) });

    current = "orphan_ledger";
    const group = await controlGroup();
    const survivors = proc.cgroupPids(group).filter(pid => String(pid) !== after.MainPID && proc.isMsb(pid));
    for (const pid of survivors) ours.add(pid);
    if (await client.login() !== 200) throw new SafeError("login_after_restart_failed"); // sessions are revoked by a restart
    const attention = ((await client.get("api/dashboard")).body as { attention: Array<{ kind: string; pid?: number }> }).attention;
    const listedOrphans = new Set(attention.filter(item => item.kind === "orphan_process").map(item => item.pid));
    const missing = survivors.filter(pid => !listedOrphans.has(pid));
    if (missing.length) throw new SafeError("orphan_not_in_ledger");
    if (proof) {
      current = "run_unknown_after_crash";
      const after = ((await client.get(`api/runs/${encodeURIComponent(proofRun)}`)).body as { status?: string }).status ?? "";
      if (after !== "unknown") throw new SafeError(`run_not_unknown_${after || "no_status"}`);
      set("run_unknown_after_crash", "PASS", null, { status: "unknown", note: "the in-flight run was not promoted to a result without evidence" });
      if (survivors.length > 0) {
        current = "orphan_blocks_send";
        const blocked = await client.post(`api/sessions/${encodeURIComponent(proofSession)}/runs`, { prompt: PROOF_PROBE_PROMPT }, { "Idempotency-Key": `f1p1-${randomBytes(12).toString("hex")}` });
        const code = (blocked.body as { error?: { code?: string } }).error?.code ?? null;
        if (blocked.status !== 409 || code !== "orphan_process_alive") throw new SafeError(`send_not_blocked_${blocked.status}_${code ?? "no_code"}`);
        set("orphan_blocks_send", "PASS", null, { status: 409, error_code: "orphan_process_alive" });
      } else set("orphan_blocks_send", "NOT_VERIFIED", "no_surviving_msb_child");
    }
    // Only our own unit's leftovers, now that the ledger was checked: the operator protocol (check, then kill) on a smoke child.
    await terminate(survivors, proc, unitGroup);
    if (proof && survivors.length > 0) {
      current = "orphan_released";
      let still = survivors.length;
      for (const end = Date.now() + 10_000; Date.now() < end && still > 0; await Bun.sleep(300)) {
        const items = ((await client.get("api/dashboard")).body as { attention: Array<{ kind: string; pid?: number }> }).attention;
        still = items.filter(item => item.kind === "orphan_process" && survivors.includes(item.pid as number)).length;
      }
      if (still > 0) throw new SafeError("orphan_still_listed_after_end");
      set("orphan_released", "PASS", null, { note: "the orphan left 'Precisa de você' by itself once the process ended" });
    } else if (proof) set("orphan_released", "NOT_VERIFIED", "no_surviving_msb_child");
    if (survivors.length === 0) set("orphan_ledger", "NOT_VERIFIED", "no_surviving_msb_child", { note: "msb exec ended together with the killed Cockpit: the ledger could not be exercised under systemd" });
    else set("orphan_ledger", "PASS", null, { surviving_msb_children: survivors.length, listed_as_orphans: survivors.length, note: "survivors were listed (blocking) and then ended by the smoke" });

    current = "msb_exec_after_restart";
    const again = await threads();
    if (again.status !== 200) throw new SafeError(`threads_${again.code ?? again.status}`);
    await remember();
    set("msb_exec_after_restart", "PASS");

    // ---------------------------------------------------------------- orderly stop: the Cockpit ends its own children
    current = "orderly_stop";
    const children = proc.cgroupPids(await controlGroup()).filter(pid => proc.isMsb(pid));
    for (const pid of children) ours.add(pid);
    await systemctl("stop", SMOKE_UNIT);
    const stopped = await show("ActiveState", "Result", "ExecMainStatus");
    await Bun.sleep(500);
    const left = children.filter(pid => proc.alive(pid));
    if (stopped.ActiveState !== "inactive" || stopped.ExecMainStatus !== "0" || left.length) throw new SafeError(left.length ? "children_left_after_stop" : "unclean_stop");
    set("orderly_stop", "PASS", null, { exit_status: 0, children_ended: children.length });

    // ---------------------------------------------------------------- refused start (78) is not restarted
    current = "refused_start_not_restarted";
    chmodSync(tokenFile, 0o644); // the Cockpit refuses a credential readable by others → exit 78
    await systemctl("reset-failed", SMOKE_UNIT);
    const restartsBefore = (await show("NRestarts")).NRestarts ?? "";
    await systemctl("start", SMOKE_UNIT);
    await Bun.sleep(timeouts.settle); // longer than RestartSec=5: an automatic restart would have happened by now
    const refused = await show("ActiveState", "SubState", "ExecMainStatus", "NRestarts");
    chmodSync(tokenFile, 0o600);
    if (refused.ExecMainStatus !== "78" || refused.ActiveState === "active" || refused.ActiveState === "activating" || refused.NRestarts !== restartsBefore) {
      throw new SafeError("refused_start_restarted_or_not_78");
    }
    set("refused_start_not_restarted", "PASS", null, { exit_status: 78, state: refused.ActiveState, automatic_restarts: 0 });

    current = "journal_clean";
    const journal = await run(["journalctl", "--user", "-u", SMOKE_UNIT, "--no-pager", "-o", "cat", "-n", "2000"]);
    if (journal.code !== 0) throw new SafeError("journal_unreadable");
    if (journal.stdout.includes(token)) throw new SafeError("credential_in_journal");
    if (!journal.stdout.includes('"event":"listening"')) throw new SafeError("journal_without_listening");
    set("journal_clean", "PASS");
  } catch (error) {
    if (report.checks.find(check => check.id === current)!.status === "NOT_VERIFIED") set(current, current === "msb_list" && safeCode(error) === "smoke_vm_not_running" ? "NOT_VERIFIED" : "FAIL", safeCode(error));
  } finally {
    // ---------------------------------------------------------------- cleanup, always (also on SIGINT/SIGTERM/SIGHUP, above)
    await cleanup();
    unregister();
  }
  const statuses = report.checks.map(check => check.status);
  report.overall = statuses.includes("FAIL") ? "FAIL" : statuses.every(status => status === "PASS") ? "PASS" : "NOT_VERIFIED";
  return report;
}

/**
 * SIGTERM, then SIGKILL after 3 s — only to `msb` processes that are, at the moment of each signal, members of the smoke
 * unit's own cgroup. A PID that was reused by any other process (another Cockpit's `msb exec`, anything else) is never touched.
 */
export async function terminate(pids: number[], proc: NonNullable<SmokeOptions["proc"]>, group: string): Promise<void> {
  const mine = (pid: number) => group.endsWith(`/${SMOKE_UNIT}`) && proc.inGroup(pid, group) && proc.isMsb(pid);
  const targets = pids.filter(mine);
  for (const pid of targets) { if (mine(pid)) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } } }
  for (const end = Date.now() + 3000; Date.now() < end && targets.some(pid => mine(pid)); await Bun.sleep(100)) { /* wait */ }
  for (const pid of targets) if (mine(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}

class SmokeClient {
  #cookie = ""; #proof = ""; #csrf = "";
  constructor(readonly base: string, private readonly token: string) {}
  async login(): Promise<number> {
    const response = await fetch(this.base + "api/auth/login", { method: "POST", headers: { Origin: this.base.slice(0, -1), "Content-Type": "application/json" }, body: JSON.stringify({ credential: this.token }) });
    if (response.status === 200) { this.#cookie = (response.headers.get("set-cookie") ?? "").split(";")[0]!; const body = await response.json() as { proof: string; csrf: string }; this.#proof = body.proof; this.#csrf = body.csrf; }
    return response.status;
  }
  async post(path: string, payload: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
    const response = await fetch(this.base + path, { method: "POST", body: JSON.stringify(payload), headers: { Cookie: this.#cookie, "X-Session-Proof": this.#proof, "X-CSRF-Token": this.#csrf,
      "X-Request-Nonce": randomBytes(16).toString("hex") + "pp", Origin: this.base.slice(0, -1), "Content-Type": "application/json", ...extra } });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  async get(path: string): Promise<{ status: number; body: unknown }> {
    const response = await fetch(this.base + path, { headers: { Cookie: this.#cookie, "X-Session-Proof": this.#proof } });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
}

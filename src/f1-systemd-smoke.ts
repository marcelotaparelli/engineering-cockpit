import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SafeError, safeCode, vmIdentity } from "./model.ts";
import { reservedVms } from "./config.ts";
import { classifyChild, procProbe } from "./process-ledger.ts";
import { blockersOf, CLAUDE_PROOF_PROMPT, code as closedCode, countRuns, hasEnoughPartial, judgeBlockedSend, judgePartialPreserved, judgeReconcileAfterRelease,
  judgeReconcileWhileOwnerAlive, parseOrphans, parseReconcile, parseReliability, readRunTranscript, type ProofProvider, type RunTranscript, type Verdict } from "./f2-proof.ts";
import { defaultRunner, isLink, newToken, parseEnvFile, portBusy, renderEnvFile, renderUnit, repoRoot, SAFE_PATH, servicePath, servicePaths, type Runner } from "./service.ts";

/**
 * F1-D — real systemd smoke on the Arch host (operator-run; never on the development VM).
 *
 * Proves that the Cockpit, started by systemd from the SAME unit template as the service (NoNewPrivileges=yes, KillMode=process,
 * Restart policy, UMask), can operate Microsandbox: `msb list` (discovery) and `msb exec` (Codex App Server initialize +
 * thread/list, read-only: no prompt, no quota). It also checks, under real systemd, crash → restart → orphan ledger, orderly
 * stop and that a refused start (exit 78) is not restarted.
 *
 * Isolation: a RUNTIME unit `engineering-cockpit-f1-smoke.service` in $XDG_RUNTIME_DIR/systemd/user (gone at reboot), its own
 * port, data directory and generated credential under .cache/. It never writes ~/.config/engineering-cockpit (it only READS the
 * installed service's `COCKPIT_RESERVED_VMS`, so a VM reserved there is refused too), never touches the installed service, the
 * operator's data/ or credentials, and never stops another Cockpit. The only processes it ever signals
 * are those inside its own unit's cgroup. Everything it created is removed at the end, PASS or FAIL.
 *
 * F2: the VM may be a Claude VM (`claude-<project>`) as well as a Codex VM. The base checks are the same (for Claude, `msb exec`
 * is the read-only `claude --version` / `--help` / `auth status` probe the Cockpit runs on connect). With the opt-in proof the
 * crash happens while one real turn is in flight, and the proof also checks, per provider: partial output preserved (Claude),
 * orphan listed, new send refused without creating a run, a conservative reconcile that opens no `msb exec` child, and the
 * release once the surviving process ended. The verdicts live in `src/f2-proof.ts`.
 */
export const SMOKE_UNIT = "engineering-cockpit-f1-smoke.service";
export const SMOKE_CHECK_IDS = ["preconditions", "unit_loaded", "start", "no_new_privileges", "credential_file", "msb_list", "msb_exec",
  "crash_restart", "orphan_ledger", "msb_exec_after_restart", "orderly_stop", "refused_start_not_restarted", "journal_clean", "cleanup"] as const;
/**
 * Proof mode (opt-in, quota): the crash happens while a REAL turn is in flight, so a real `msb exec` child can survive it and the
 * orphan ledger, the send block and the reconcile are exercised for real under systemd. Needs COCKPIT_SMOKE_ORPHAN_PROOF=yes AND
 * COCKPIT_SMOKE_QUOTA_CONFIRMED=yes. One list per provider: Claude also checks that the streamed partial answer survives the kill.
 */
export const SMOKE_PROOF_CHECK_IDS = ["orphan_turn_started", "run_unknown_after_crash", "orphan_blocks_send", "reconcile_conservative", "orphan_released", "reconcile_after_release"] as const;
export const SMOKE_CLAUDE_PROOF_CHECK_IDS = ["orphan_turn_started", "partial_preserved", "run_unknown_after_crash", "orphan_blocks_send", "reconcile_conservative", "orphan_released", "reconcile_after_release"] as const;
/** The only prompt the proof sends (one turn, no tools): long enough to outlive the SIGKILL, small enough to cost little quota. */
export const PROOF_PROMPT = "Teste automatizado F1-P1, sem usar ferramentas: escreva 300 linhas numeradas, cada uma com uma frase curta sobre o mar.";
/** Sent only to PROVE it is refused while an orphan is alive; if it were accepted, it is as harmless as a prompt can be. */
export const PROOF_PROBE_PROMPT = "Responda apenas: ok.";
type CheckId = typeof SMOKE_CHECK_IDS[number] | typeof SMOKE_PROOF_CHECK_IDS[number] | typeof SMOKE_CLAUDE_PROOF_CHECK_IDS[number];
type Status = "PASS" | "FAIL" | "NOT_VERIFIED";
export interface SmokeCheck { id: CheckId; status: Status; reason: string | null; evidence?: Record<string, unknown> }
export interface SmokeReport { milestone: "F1-D-systemd-smoke"; timestamp: string; overall: Status; unit: string; vm: string | null; provider: ProofProvider | null; checks: SmokeCheck[] }

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
    inGroup(pid: number, controlGroup: string): boolean;
    /**
     * The process's argv (`/proc/<pid>/cmdline`), or null when unreadable. Tells `msb exec` children apart from `msb list`. The real
     * reader always provides it; a stand-in that omits it keeps the F1 behaviour (every `msb` process in the cgroup counts).
     */
    argv?(pid: number): string[] | null;
    /** Kernel start time of the process (`/proc/<pid>/stat`, field 22), or null. With it, `terminate` never signals a PID that was reused. */
    startTicks?(pid: number): string | null };
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
  argv: pid => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(part => part !== ""); } catch { return null; } },
  startTicks: pid => procProbe.startTicks(pid),
  inGroup: (pid, group) => {
    if (!group) return false;
    try { return readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").some(line => line === `0::${group}`); } catch { return false; }
  },
};

const realOnInterrupt: NonNullable<SmokeOptions["onInterrupt"]> = handler => {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let fired = false;
  // One handler run. Further signals are ignored while the cleanup runs (a second Ctrl+C must not cut it short); the process then ends
  // normally once the smoke returns its report, which the caller prints once.
  const listener = () => { if (fired) { console.error("f1-systemd-smoke: interrupted, cleaning up…"); return; } fired = true; void handler(); };
  for (const signal of signals) process.on(signal, listener);
  return () => { for (const signal of signals) process.off(signal, listener); };
};

export async function runSystemdSmoke(options: SmokeOptions = {}): Promise<SmokeReport> {
  const env = options.env ?? process.env;
  const onInterrupt = options.onInterrupt ?? realOnInterrupt;
  // systemctl/journalctl in their own process group: a second Ctrl+C in the terminal must not kill the `systemctl stop` of the cleanup.
  const run = options.run ?? defaultRunner({ detached: true });
  const root = options.root ?? repoRoot();
  const proc = options.proc ?? realProc;
  const timeouts = options.timeoutsMs ?? { start: 20_000, restart: 30_000, settle: 8_000 };
  const proof = env.COCKPIT_SMOKE_ORPHAN_PROOF === "yes";
  // The provider follows the VM name (`claude-…` or `codex-…`); the preconditions below refuse anything else before anything is created.
  const provider: ProofProvider = (env.COCKPIT_SMOKE_VM ?? "").startsWith("claude-") ? "claude" : "codex";
  const report: SmokeReport = { milestone: "F1-D-systemd-smoke", timestamp: new Date().toISOString(), overall: "FAIL", unit: SMOKE_UNIT, vm: null, provider: null,
    checks: [...SMOKE_CHECK_IDS, ...(proof ? (provider === "claude" ? SMOKE_CLAUDE_PROOF_CHECK_IDS : SMOKE_PROOF_CHECK_IDS) : [])].map(id => ({ id, status: "NOT_VERIFIED", reason: "not_exercised" })) };
  /** Set by an interrupt: no request, start or signal of the main flow happens after it (each one checks it first). */
  const stop = new AbortController();
  // After an interrupt no step of the main flow is promoted to PASS (one cut short keeps its `interrupted` mark); the cleanup still reports.
  const set = (id: CheckId, status: Status, reason: string | null = null, evidence?: Record<string, unknown>) => stop.signal.aborted && status === "PASS" && id !== "cleanup" ? undefined :
    Object.assign(report.checks.find(check => check.id === id)!, { status, reason, ...(evidence ? { evidence } : {}) });
  /** Records a verdict WITHOUT aborting: each real run spends quota, so one failed check must not hide what the others show. */
  const record = (id: CheckId, verdict: Verdict) => set(id, verdict.status, verdict.reason, verdict.evidence);
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
  let vm = "", project = "", port = 0, runtimeDir = "", path = "", extraReserved = "";
  try {
    if (process.platform !== "linux") throw new SafeError("linux_required");
    if (env.COCKPIT_F1_SMOKE_CONFIRMED !== "yes") throw new SafeError("confirmation_required");
    if (proof && env.COCKPIT_SMOKE_QUOTA_CONFIRMED !== "yes") throw new SafeError("quota_confirmation_required");
    vm = env.COCKPIT_SMOKE_VM ?? "";
    const identity = (() => { try { return vmIdentity(vm); } catch { throw new SafeError("smoke_vm_invalid"); } })();
    if (identity.provider !== "codex" && identity.provider !== "claude") throw new SafeError("smoke_vm_must_be_codex_or_claude");
    // The Cockpit would refuse these VMs anyway (and a real prompt must never reach the development VM): refuse before creating anything.
    // The reserved list normally lives in the installed service's env file, not in the shell: read it (read-only) and add it.
    extraReserved = [...new Set([...(env.COCKPIT_RESERVED_VMS ?? "").split(","), ...installedReservedVms(env).split(",")].map(name => name.trim()).filter(Boolean))].join(",");
    if (reservedVms(extraReserved).includes(vm)) throw new SafeError("smoke_vm_reserved");
    project = identity.project;
    report.vm = vm;
    report.provider = identity.provider;
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
  const guard = () => { if (stop.signal.aborted) throw new SafeError("interrupted"); };
  let cleaning: Promise<void> | null = null;
  let startedAt = 0; // epoch seconds just before the unit is created: the journal check reads from here
  /** Idempotent and shared: the interrupt and the `finally` await the SAME run, so neither returns while the other is still cleaning. */
  const cleanup = (): Promise<void> => (cleaning ??= doCleanup());
  /** Stops the unit, ends everything in ITS cgroup (systemd addresses the cgroup, never a PID), verifies, removes files. */
  const doCleanup = async (): Promise<void> => {
    const problems: string[] = [];
    if (created) {
      if ((await systemctl("stop", SMOKE_UNIT)).code !== 0) problems.push("stop");
      await systemctl("kill", "--kill-whom=all", "--signal=SIGKILL", SMOKE_UNIT);
      await systemctl("reset-failed", SMOKE_UNIT);
      // A SIGKILLed process stays listed (and the unit `deactivating`) for a few ms: wait for it to settle before calling it a leftover.
      let state = "unknown";
      for (const end = Date.now() + Math.min(3000, timeouts.settle * 4); ; await Bun.sleep(100)) {
        state = (await show("ActiveState")).ActiveState ?? "unknown";
        if ((state === "inactive" || state === "failed") && !(unitGroup && proc.cgroupPids(unitGroup).length)) break;
        if (Date.now() >= end) break;
      }
      if (state !== "inactive" && state !== "failed") problems.push(`unit_${state}`);
      if (unitGroup && proc.cgroupPids(unitGroup).length) problems.push("cgroup_not_empty");
      try { rmSync(unitFile!, { force: true }); } catch { problems.push("unit_file"); }
      if ((await systemctl("daemon-reload")).code !== 0) problems.push("daemon_reload");
    }
    if (workDir) { try { rmSync(workDir, { recursive: true, force: true }); } catch { problems.push("work_dir"); } }
    set("cleanup", problems.length ? "FAIL" : "PASS", problems.join(",") || null);
  };
  const unregister = onInterrupt(async () => {
    // Stop the main flow first (in-flight requests are aborted, the next request/start/signal is refused), then clean up at once. The
    // main flow ends in its `finally`, awaits this same cleanup and returns the report, which the caller prints ONCE (a real prompt may
    // already have been spent, so what was observed is never lost).
    stop.abort();
    set(current, "FAIL", "interrupted");
    await cleanup();
  });
  try {
    // ---------------------------------------------------------------- isolated state + runtime unit from the real template
    startedAt = Math.floor(Date.now() / 1000);
    guard(); // from here to `created = true` everything is synchronous: an interrupt cannot slip between this check and the unit file
    const base = join(root, ".cache", "f1-systemd-smoke");
    mkdirSync(base, { recursive: true, mode: 0o700 }); chmodSync(base, 0o700);
    workDir = join(base, `run-${Date.now()}-${randomBytes(4).toString("hex")}`);
    mkdirSync(workDir, { mode: 0o700 }); chmodSync(workDir, 0o700);
    const tokenFile = join(workDir, "token");
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: "wx" });
    const envFile = join(workDir, "cockpit.env");
    writeFileSync(envFile, renderEnvFile({ COCKPIT_MODE: "host", COCKPIT_HOST_CONFIRMED: "yes", COCKPIT_PROJECTS_BASE: env.COCKPIT_PROJECTS_BASE!,
      COCKPIT_ALLOWED_PROJECTS: project, PORT: String(port), COCKPIT_DATA_DIR: join(workDir, "data"), COCKPIT_LOCAL_TOKEN_FILE: tokenFile, PATH: path,
      ...(extraReserved ? { COCKPIT_RESERVED_VMS: extraReserved } : {}),
      ...(env.LANG && /^[A-Za-z0-9._@-]+$/.test(env.LANG) ? { LANG: env.LANG } : {}) }), { mode: 0o600, flag: "wx" });
    mkdirSync(join(runtimeDir, "systemd/user"), { recursive: true, mode: 0o700 });
    writeFileSync(unitFile, renderUnit(root, envFile), { mode: 0o644, flag: "wx" });
    created = true;
    if ((await systemctl("daemon-reload")).code !== 0) throw new SafeError("daemon_reload_failed");
    const loaded = await show("FragmentPath", "NoNewPrivileges", "KillMode", "Restart", "RestartPreventExitStatus");
    if (loaded.FragmentPath !== unitFile) throw new SafeError("smoke_unit_not_loaded");
    set("unit_loaded", "PASS", null, { no_new_privileges: loaded.NoNewPrivileges, kill_mode: loaded.KillMode, restart: loaded.Restart, prevent: loaded.RestartPreventExitStatus });

    const url = `http://127.0.0.1:${port}/`;
    const healthy = async (ms: number) => { for (const end = Date.now() + ms; Date.now() < end && !stop.signal.aborted; await Bun.sleep(300)) { try { if ((await fetch(url + "api/health", { signal: AbortSignal.timeout(5000) })).ok) return true; } catch { /* not yet */ } } return false; };
    const client = new SmokeClient(url, token, stop.signal);
    const cc = (value: unknown) => closedCode(value) ?? "invalid"; // server values reach `reason`: closed vocabulary only
    const threads = async () => { const r = await client.get(`api/vms/${encodeURIComponent(vm)}/threads`); return { status: r.status, code: closedCode((r.body as { error?: { code?: string } }).error?.code) }; };
    const controlGroup = async () => { const group = (await show("ControlGroup")).ControlGroup ?? ""; if (group.endsWith(`/${SMOKE_UNIT}`)) unitGroup = group; return group; };
    const remember = async () => { const group = await controlGroup(); for (const pid of proc.cgroupPids(group)) if (proc.isMsb(pid)) ours.add(pid); };
    /** Only `msb exec --stream <vm> -- <codex|claude> …` children count (what the Cockpit's ledger tracks); `msb list` and the like do not. */
    const isExecChild = (pid: number) => {
      if (!proc.argv) return true;
      const argv = proc.argv(pid);
      return argv !== null && argv.length > 0 && classifyChild([basename(argv[0]!), ...argv.slice(1)]) !== null;
    };
    /**
     * Runs `work` while sampling the unit's cgroup every 20 ms for NEW `msb` processes. Exec children are counted; a new `msb` whose argv
     * cannot be read cannot be classified and is counted as unreadable (the verdict is then NOT_VERIFIED). A child that is born and dies
     * between two samples is invisible here: the verdict therefore also compares the Cockpit's own counters (see f2-proof.ts).
     */
    const watchNewChildren = async <T>(work: () => Promise<T>): Promise<{ value: T; seen: Set<number>; unreadable: number }> => {
      if (!unitGroup) throw new SafeError("unit_cgroup_unknown");
      const baseline = new Set(proc.cgroupPids(unitGroup).filter(pid => proc.isMsb(pid)));
      const seen = new Set<number>(); const unreadable = new Set<number>(); let done = false;
      const sample = () => { for (const pid of proc.cgroupPids(unitGroup)) if (proc.isMsb(pid) && !baseline.has(pid) && !seen.has(pid) && !unreadable.has(pid)) {
        if (proc.argv && proc.argv(pid) === null) unreadable.add(pid); else if (isExecChild(pid)) seen.add(pid); } };
      const sampler = (async () => { while (!done) { sample(); await Bun.sleep(20); } })();
      let value: T;
      try { value = await work(); } finally { done = true; await sampler; sample(); } // one last look after the call, BEFORE the counts are read
      return { value, seen, unreadable: unreadable.size };
    };
    const execChildren = () => {
      // Without the unit's own cgroup nothing can be listed, and "no new child" would pass for the wrong reason: fail closed instead.
      if (!unitGroup) throw new SafeError("unit_cgroup_unknown");
      return proc.cgroupPids(unitGroup).filter(pid => proc.isMsb(pid) && isExecChild(pid));
    };

    // ---------------------------------------------------------------- start under systemd
    current = "start";
    guard();
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
    if (dashboard.discovery_error) throw new SafeError(`discovery_${cc(dashboard.discovery_error)}`);
    const seen = dashboard.vms.find(item => item.vm_name === vm);
    if (!seen) throw new SafeError("smoke_vm_not_listed");
    if (seen.vm_state !== "running") { set("msb_list", "PASS", null, { vm_state: seen.vm_state }); throw new SafeError("smoke_vm_not_running"); }
    set("msb_list", "PASS", null, { vm_state: "running" });

    current = "msb_exec";
    const listed = await threads();
    if (listed.status !== 200) throw new SafeError(`threads_${listed.code ?? listed.status}`);
    await remember();
    set("msb_exec", "PASS", null, { route: provider === "claude" ? "GET /api/vms/:vm/threads (claude --version, --help, auth status via msb exec, read-only)" : "GET /api/vms/:vm/threads (initialize + thread/list, read-only)", msb_children_in_unit: ours.size });

    // ---------------------------------------------------------------- proof (opt-in): a real turn is in flight when the Cockpit is killed
    const enc = encodeURIComponent;
    let proofSession = ""; let proofRun = "";
    let partialBefore: RunTranscript | null = null; // Claude: the partial answer the Cockpit had persisted, read while the run was live
    if (proof) {
      current = "orphan_turn_started";
      const created = await client.post("api/sessions", { vm_name: vm, mode: "new" });
      proofSession = (created.body as { session_id?: string }).session_id ?? "";
      if (created.status !== 201 || !proofSession) throw new SafeError(`proof_session_${cc((created.body as { error?: { code?: string } }).error?.code ?? `http_${created.status}`)}`);
      const sent = await client.post(`api/sessions/${enc(proofSession)}/runs`, { prompt: provider === "claude" ? CLAUDE_PROOF_PROMPT : PROOF_PROMPT }, { "Idempotency-Key": `f1p1-${randomBytes(12).toString("hex")}` });
      proofRun = (sent.body as { run_id?: string }).run_id ?? "";
      if (sent.status !== 202 || !proofRun) throw new SafeError(`proof_run_${cc((sent.body as { error?: { code?: string } }).error?.code ?? `http_${sent.status}`)}`);
      const readRun = async () => (await client.get(`api/runs/${enc(proofRun)}`)).body as { status?: string; provider_bound?: boolean };
      const inFlight = (status: string) => status === "running" || status === "awaiting_approval";
      let runStatus = "";
      for (const end = Date.now() + timeouts.start; Date.now() < end && !inFlight(runStatus); await Bun.sleep(300)) {
        runStatus = (await readRun()).status ?? "";
        if (["completed", "failed", "interrupted", "unknown"].includes(runStatus)) break;
      }
      if (!inFlight(runStatus)) throw new SafeError(`proof_turn_not_in_flight_${cc(runStatus || "no_status")}`);
      if (provider === "claude") {
        // The kill must land on a turn that already streamed text the Cockpit persisted (it flushes at most once a second): wait for it,
        // bounded, remember what the history shows, and kill at once. If the model never streams enough, the turn is still killed and
        // `partial_preserved` is reported NOT_VERIFIED rather than guessed.
        for (const end = Date.now() + timeouts.start; Date.now() < end; await Bun.sleep(300)) {
          const read = await readRunTranscript(client, proofSession, proofRun);
          if (hasEnoughPartial(read)) { partialBefore = read; break; }
          if (!inFlight((await readRun()).status ?? "")) break;
        }
        runStatus = (await readRun()).status ?? "";
        if (!inFlight(runStatus)) throw new SafeError(`proof_turn_not_in_flight_${cc(runStatus || "no_status")}`);
      }
      await remember();
      set("orphan_turn_started", "PASS", null, { run_status: runStatus, provider, provider_bound: (await readRun()).provider_bound === true, msb_children_in_unit: ours.size,
        ...(provider === "claude" ? { partial_text_persisted_before_kill: partialBefore !== null } : {}),
        note: "one real prompt was sent to the smoke VM; it is the operator's quota spend" });
    }

    // ---------------------------------------------------------------- crash → systemd restart → orphan ledger
    current = "crash_restart";
    const before = await show("MainPID", "NRestarts");
    guard();
    await systemctl("kill", "--signal=SIGKILL", "--kill-whom=main", SMOKE_UNIT);
    let after: Record<string, string> = {};
    for (const end = Date.now() + timeouts.restart; Date.now() < end; await Bun.sleep(500)) {
      guard();
      after = await show("MainPID", "NRestarts", "ActiveState");
      if (after.ActiveState === "active" && after.MainPID !== "0" && after.MainPID !== before.MainPID && Number(after.NRestarts) > Number(before.NRestarts || "0")) break;
    }
    if (after.ActiveState !== "active" || after.MainPID === before.MainPID || !(await healthy(timeouts.start))) throw new SafeError("not_restarted_after_crash");
    set("crash_restart", "PASS", null, { restarts: Number(after.NRestarts) });

    current = "orphan_ledger";
    const group = await controlGroup();
    // Only `msb exec` children are what the ledger tracks (and so what can be an orphan); a transient `msb list` is neither.
    const survivors = proc.cgroupPids(group).filter(pid => String(pid) !== after.MainPID && proc.isMsb(pid) && isExecChild(pid));
    for (const pid of survivors) ours.add(pid);
    if (await client.login() !== 200) throw new SafeError("login_after_restart_failed"); // sessions are revoked by a restart
    const orphans = parseOrphans((await client.get("api/dashboard")).body) ?? [];
    const listedOrphans = new Set(orphans.map(item => item.pid));
    const missing = survivors.filter(pid => !listedOrphans.has(pid));
    if (missing.length) throw new SafeError("orphan_not_in_ledger");
    let blockers: ReturnType<typeof blockersOf> = [];
    if (proof) {
      current = "run_unknown_after_crash";
      const runNow = (await client.get(`api/runs/${enc(proofRun)}`)).body as { status?: string; reason_code?: string | null };
      if ((runNow.status ?? "") !== "unknown") throw new SafeError(`run_not_unknown_${cc(runNow.status || "no_status")}`);
      set("run_unknown_after_crash", "PASS", null, { status: "unknown", reason_code: closedCode(runNow.reason_code), note: "the in-flight run was not promoted to a result without evidence" });

      if (provider === "claude") {
        current = "partial_preserved";
        if (!partialBefore) set("partial_preserved", "NOT_VERIFIED", "no_partial_text_before_kill", { note: "the model had not streamed enough persisted text when the Cockpit was killed" });
        else record("partial_preserved", judgePartialPreserved(partialBefore, await readRunTranscript(client, proofSession, proofRun)));
      }

      blockers = blockersOf(orphans, provider, vm, proofSession, survivors);
      const noBlocker = survivors.length ? "no_blocking_orphan_for_proof_session" : "no_surviving_msb_child";
      current = "orphan_blocks_send";
      if (blockers.length > 0) {
        const blocked = await client.post(`api/sessions/${enc(proofSession)}/runs`, { prompt: PROOF_PROBE_PROMPT }, { "Idempotency-Key": `f1p1-${randomBytes(12).toString("hex")}` });
        record("orphan_blocks_send", judgeBlockedSend(blocked, countRuns((await client.get(`api/sessions/${enc(proofSession)}`)).body)));
      } else set("orphan_blocks_send", "NOT_VERIFIED", noBlocker);

      // A reconcile while the surviving process may still own the turn must be conservative AND open nothing beside it. Claude's
      // answer does not depend on the orphan (a restart always loses the process), so it is checked even without a survivor; Codex's
      // (`orphan_owns_turn`) exists only because of one.
      current = "reconcile_conservative";
      if (provider === "codex" && blockers.length === 0) set("reconcile_conservative", "NOT_VERIFIED", noBlocker);
      else {
        const counters = async () => parseReliability((await client.get("api/dashboard")).body);
        const before = await counters();
        const known = new Set(execChildren()); // every msb process of the unit now: anything else that shows up is new
        const { value: reconciled, seen, unreadable } = await watchNewChildren(() => client.post(`api/runs/${enc(proofRun)}/reconcile`, {}));
        for (const pid of seen) ours.add(pid); // inside our cgroup: the final cleanup ends them with the rest
        record("reconcile_conservative", judgeReconcileWhileOwnerAlive(provider, parseReconcile(reconciled),
          { newExecChildren: [...seen].filter(pid => !known.has(pid)).length, unreadableChildren: unreadable, before, after: await counters(), orphanAlive: survivors.length > 0 }));
      }
    }
    // Only our own unit's leftovers, and only now that the ledger, the block and the reconcile were checked: the operator protocol
    // (check, then end) applied to a smoke child. `terminate` signals a PID only while it is a member of THIS unit's cgroup.
    const listedTicks = new Map(survivors.map(pid => [pid, proc.startTicks?.(pid) ?? null] as const));
    guard();
    await terminate(survivors, proc, unitGroup, pid => isExecChild(pid) && (listedTicks.get(pid) === null || proc.startTicks?.(pid) === listedTicks.get(pid)), stop.signal);
    if (proof) {
      current = "orphan_released";
      if (survivors.length > 0) {
        // Only a READABLE list without the orphan is a release: an error page or a malformed body proves nothing (keep polling).
        let still = survivors.length; let readable = false;
        for (const end = Date.now() + Math.min(10_000, timeouts.restart); Date.now() < end && !(readable && still === 0); await Bun.sleep(300)) {
          const listed = parseOrphans((await client.get("api/dashboard")).body);
          readable = listed !== null;
          if (listed) still = listed.filter(item => survivors.includes(item.pid)).length;
        }
        if (!readable) set("orphan_released", "NOT_VERIFIED", "orphan_list_unreadable", { note: "the dashboard could not be read after the orphan was ended" });
        else if (still > 0) throw new SafeError("orphan_still_listed_after_end");
        else set("orphan_released", "PASS", null, { note: "the orphan left 'Precisa de você' by itself once the host msb exec process ended", inside_vm: "not_observed (the agent in the VM may keep running its turn)" });
      } else set("orphan_released", "NOT_VERIFIED", "no_surviving_msb_child");
      // Asked after the end of the process: Claude must still not resolve it; Codex's real answer is observed (open L4 / P3 question).
      current = "reconcile_after_release";
      record("reconcile_after_release", judgeReconcileAfterRelease(provider, parseReconcile(await client.post(`api/runs/${enc(proofRun)}/reconcile`, {})), survivors.length > 0));
    }
    if (survivors.length === 0) set("orphan_ledger", "NOT_VERIFIED", "no_surviving_msb_child", { note: "msb exec ended together with the killed Cockpit: the ledger could not be exercised under systemd" });
    else set("orphan_ledger", "PASS", null, { surviving_msb_children: survivors.length, listed_as_orphans: survivors.length,
      kinds: Object.fromEntries([...new Set(orphans.filter(item => survivors.includes(item.pid)).map(item => item.kind))].map(kind => [kind, orphans.filter(item => survivors.includes(item.pid) && item.kind === kind).length])),
      note: "survivors were listed (blocking) and then ended by the smoke" });

    current = "msb_exec_after_restart";
    const again = await threads();
    if (again.status !== 200) throw new SafeError(`threads_${again.code ?? again.status}`);
    await remember();
    set("msb_exec_after_restart", "PASS");

    // ---------------------------------------------------------------- orderly stop: the Cockpit ends its own children
    current = "orderly_stop";
    const children = proc.cgroupPids(await controlGroup()).filter(pid => proc.isMsb(pid));
    for (const pid of children) ours.add(pid);
    guard();
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
    guard();
    await systemctl("start", SMOKE_UNIT);
    await Bun.sleep(timeouts.settle); // longer than RestartSec=5: an automatic restart would have happened by now
    const refused = await show("ActiveState", "SubState", "ExecMainStatus", "NRestarts");
    chmodSync(tokenFile, 0o600);
    if (refused.ExecMainStatus !== "78" || refused.ActiveState === "active" || refused.ActiveState === "activating" || refused.NRestarts !== restartsBefore) {
      throw new SafeError("refused_start_restarted_or_not_78");
    }
    set("refused_start_not_restarted", "PASS", null, { exit_status: 78, state: refused.ActiveState, automatic_restarts: 0 });

    current = "journal_clean";
    // Only this run's lines: an earlier smoke (e.g. the Claude proof right before the Codex one) must not satisfy `listening` for it.
    const journal = await run(["journalctl", "--user", "-u", SMOKE_UNIT, "--since", `@${startedAt}`, "--no-pager", "-o", "cat", "-n", "2000"]);
    if (journal.code !== 0) throw new SafeError("journal_unreadable");
    if (journal.stdout.includes(token)) throw new SafeError("credential_in_journal");
    // The Cockpit logs codes and counts, never prompts or model text: the prompts the proof sent and the start of the partial it read must not be there.
    const partialHead = partialBefore ? [...partialBefore.agentItems.values()].map(item => item.text.slice(0, 40)).filter(text => text.length >= 20) : [];
    if ([CLAUDE_PROOF_PROMPT, PROOF_PROMPT, PROOF_PROBE_PROMPT, ...partialHead].some(text => journal.stdout.includes(text))) throw new SafeError("prompt_or_model_text_in_journal");
    if (!journal.stdout.includes('"event":"listening"')) throw new SafeError("journal_without_listening");
    set("journal_clean", "PASS");
  } catch (error) {
    // NOT_VERIFIED, not FAIL: the VM was not running (said nothing about the Cockpit), or the real turn ended before the kill (too fast to be killed in flight).
    const inconclusive = (current === "msb_list" && safeCode(error) === "smoke_vm_not_running") || (current === "orphan_turn_started" && safeCode(error) === "proof_turn_not_in_flight_completed");
    if (report.checks.find(check => check.id === current)!.status === "NOT_VERIFIED") set(current, inconclusive ? "NOT_VERIFIED" : "FAIL", safeCode(error));
  } finally {
    // ---------------------------------------------------------------- cleanup, always (also on SIGINT/SIGTERM/SIGHUP, above)
    await cleanup();
    unregister();
  }
  if (stop.signal.aborted && !report.checks.some(check => check.reason === "interrupted")) set(current, "FAIL", "interrupted");
  const statuses = report.checks.map(check => check.status);
  report.overall = statuses.includes("FAIL") ? "FAIL" : statuses.every(status => status === "PASS") ? "PASS" : "NOT_VERIFIED";
  return report;
}

/**
 * `COCKPIT_RESERVED_VMS` of the INSTALLED service (`~/.config/engineering-cockpit/cockpit.env`, read-only), or "" when there is no
 * installed service (no file, or no HOME/XDG_CONFIG_HOME to locate it). A file that exists but cannot be read or parsed is refused:
 * the smoke must not guess which VMs the operator reserved before it sends a real prompt.
 */
export function installedReservedVms(env: Record<string, string | undefined>): string {
  if (!env.XDG_CONFIG_HOME && !env.HOME) return ""; // nowhere to look: no installed service can be located
  let file: string;
  try { file = servicePaths(env).envFile; } catch { throw new SafeError("service_env_unreadable"); } // HOME/XDG_CONFIG_HOME set but unusable
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw new SafeError("service_env_unreadable"); } // only "absent" is absent
  try { return parseEnvFile(text).COCKPIT_RESERVED_VMS ?? ""; } catch { throw new SafeError("service_env_unreadable"); }
}

/**
 * SIGTERM, then SIGKILL after 3 s — only to `msb` processes that are, at the moment of each signal, members of the smoke
 * unit's own cgroup. A PID that was reused by any other process (another Cockpit's `msb exec`, anything else) is never touched.
 */
export async function terminate(pids: number[], proc: NonNullable<SmokeOptions["proc"]>, group: string, verify: (pid: number) => boolean = () => true,
  stop: AbortSignal = new AbortController().signal): Promise<void> {
  // After an interrupt no further signal is sent from here: the cleanup ends the whole unit cgroup through systemd.
  // `verify` re-checks, at each signal, that the PID is still the process that was listed (same start time, still an `msb exec` child).
  const mine = (pid: number) => group.endsWith(`/${SMOKE_UNIT}`) && proc.inGroup(pid, group) && proc.isMsb(pid) && verify(pid);
  const targets = pids.filter(mine);
  for (const pid of targets) { if (!stop.aborted && mine(pid)) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } } }
  for (const end = Date.now() + 3000; Date.now() < end && !stop.aborted && targets.some(pid => mine(pid)); await Bun.sleep(100)) { /* wait */ }
  for (const pid of targets) if (!stop.aborted && mine(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}

/** A hung Cockpit must end the smoke with a FAIL and its cleanup, not block until Ctrl-C. */
const HTTP_TIMEOUT_MS = 30_000;

class SmokeClient {
  #cookie = ""; #proof = ""; #csrf = "";
  constructor(readonly base: string, private readonly token: string, private readonly stop: AbortSignal = new AbortController().signal) {}
  /** Refuses any request once the smoke was interrupted, and aborts one in flight. */
  #signal(): AbortSignal { if (this.stop.aborted) throw new SafeError("interrupted"); return AbortSignal.any([AbortSignal.timeout(HTTP_TIMEOUT_MS), this.stop]); }
  async login(): Promise<number> {
    const response = await fetch(this.base + "api/auth/login", { method: "POST", signal: this.#signal(), headers: { Origin: this.base.slice(0, -1), "Content-Type": "application/json" }, body: JSON.stringify({ credential: this.token }) });
    if (response.status === 200) { this.#cookie = (response.headers.get("set-cookie") ?? "").split(";")[0]!; const body = await response.json() as { proof: string; csrf: string }; this.#proof = body.proof; this.#csrf = body.csrf; }
    return response.status;
  }
  async post(path: string, payload: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
    const response = await fetch(this.base + path, { method: "POST", signal: this.#signal(), body: JSON.stringify(payload), headers: { Cookie: this.#cookie, "X-Session-Proof": this.#proof, "X-CSRF-Token": this.#csrf,
      "X-Request-Nonce": randomBytes(16).toString("hex") + "pp", Origin: this.base.slice(0, -1), "Content-Type": "application/json", ...extra } });
    const body = await response.json().catch(() => ({}));
    if (this.stop.aborted) throw new SafeError("interrupted"); // an abort while reading the body is not an empty answer
    return { status: response.status, body };
  }
  async get(path: string): Promise<{ status: number; body: unknown }> {
    const response = await fetch(this.base + path, { signal: this.#signal(), headers: { Cookie: this.#cookie, "X-Session-Proof": this.#proof } });
    const body = await response.json().catch(() => ({}));
    if (this.stop.aborted) throw new SafeError("interrupted"); // an abort while reading the body is not an empty answer
    return { status: response.status, body };
  }
}

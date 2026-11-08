import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeError, safeCode } from "./model.ts";
import { readLocalCredentialFile } from "./config.ts";
import { doctor, parseEnvFile, repoRoot, servicePaths, SERVICE_UNIT, validateSettings, type Runner } from "./service.ts";
import { hostFacts } from "./host.ts";

/**
 * F1 real-host acceptance, READ-ONLY tier (operator-run on the Arch host, against the INSTALLED service).
 *
 * What it never does: write, start, stop, restart, signal, install, send a prompt, open the runtime database, read provider
 * credentials, or print the Cockpit credential. Every probe is a read: `systemctl --user show`, `/proc/<pid>/{status,cmdline,environ,cgroup}`,
 * `/proc/net/tcp*`, `stat`, `journalctl --user` and unauthenticated GETs of the service's own loopback port.
 *
 * One OPT-IN step changes (in-memory) state and therefore needs the operator's explicit confirmation (`withLogin` +
 * COCKPIT_F1_ACCEPT_CONFIRMED=yes): a login with the configured credential file, one read of the dashboard (reliability counters,
 * orphans, attention) and a logout. The credential is read in-process, never printed, never sent anywhere but the service's loopback
 * port; no run, session or approval is created.
 *
 * Honest outcomes: a probe that could not run is NOT_VERIFIED, never PASS. Overall is PASS only when every check passed.
 */
export type RealStatus = "PASS" | "FAIL" | "NOT_VERIFIED" | "INFO";
export interface RealCheck { id: string; status: RealStatus; reason: string | null; evidence?: Record<string, unknown> }
export interface RealReport {
  milestone: "F1-acceptance-real-readonly"; timestamp: string; overall: "PASS" | "FAIL" | "NOT_VERIFIED";
  /** `none` unless the opt-in login ran: then `in_memory_session` (created and revoked; nothing persistent). */
  state_changed: "none" | "in_memory_session"; checks: RealCheck[];
}
export interface RealProc {
  status(pid: number): string | null; cmdline(pid: number): string | null; environKeys(pid: number): string[] | null;
  cgroup(pid: number): string | null; cgroupPids(group: string): number[]; comm(pid: number): string | null;
  /** Contents of /proc/net/tcp and /proc/net/tcp6 (null when unreadable). */
  netTcp(): string[] | null;
}
export interface RealOptions {
  env?: Record<string, string | undefined>; run?: Runner; root?: string; proc?: RealProc; fetch?: typeof fetch;
  withLogin?: boolean; platform?: string; facts?: { osRelease: string };
}

const readOr = <T,>(read: () => T): T | null => { try { return read(); } catch { return null; } };
export const realProc: RealProc = {
  status: pid => readOr(() => readFileSync(`/proc/${pid}/status`, "utf8")),
  cmdline: pid => readOr(() => readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ")),
  environKeys: pid => readOr(() => readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map(entry => entry.slice(0, entry.indexOf("=")))),
  cgroup: pid => readOr(() => (readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").find(line => line.startsWith("0::")) ?? "").slice(3) || null),
  cgroupPids: group => readOr(() => group.startsWith("/") && !group.split("/").includes("..") ? readFileSync(`/sys/fs/cgroup${group}/cgroup.procs`, "utf8").split("\n").filter(Boolean).map(Number).filter(Number.isSafeInteger) : []) ?? [],
  comm: pid => readOr(() => readFileSync(`/proc/${pid}/comm`, "utf8").trim()),
  netTcp: () => readOr(() => [readFileSync("/proc/net/tcp", "utf8"), existsSync("/proc/net/tcp6") ? readFileSync("/proc/net/tcp6", "utf8") : ""]),
};

/** LISTEN sockets of `port` in /proc/net/tcp(6) text: `loopback` for 127.0.0.1 / ::1 / ::ffff:127.0.0.1, `wildcard` for 0.0.0.0 / ::, else `other`. */
export function listeners(tables: readonly string[], port: number): Array<"loopback" | "wildcard" | "other"> {
  const found: Array<"loopback" | "wildcard" | "other"> = [];
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  for (const table of tables) for (const line of table.split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/);
    const local = columns[1] ?? ""; const state = columns[3] ?? "";
    if (state !== "0A" || !local.endsWith(`:${hexPort}`)) continue;
    const address = local.slice(0, local.lastIndexOf(":"));
    if (address === "0100007F" || address === "00000000000000000000000001000000" || address === "0000000000000000FFFF00000100007F") found.push("loopback");
    else if (/^0+$/.test(address)) found.push("wildcard");
    else found.push("other");
  }
  return found;
}

const SHOW = ["ActiveState", "SubState", "MainPID", "NRestarts", "ControlGroup", "NoNewPrivileges", "KillMode", "Restart", "RestartPreventExitStatus", "UMask", "FragmentPath"];

export async function runRealReadonly(options: RealOptions): Promise<RealReport> {
  const env = options.env ?? process.env;
  const run = options.run;
  if (!run) throw new SafeError("runner_required");
  const root = options.root ?? repoRoot();
  const proc = options.proc ?? realProc;
  const http = options.fetch ?? fetch;
  const report: RealReport = { milestone: "F1-acceptance-real-readonly", timestamp: new Date().toISOString(), overall: "NOT_VERIFIED", state_changed: "none", checks: [] };
  const add = (id: string, status: RealStatus, reason: string | null = null, evidence?: Record<string, unknown>) => { report.checks.push({ id, status, reason, ...(evidence ? { evidence } : {}) }); };
  const finish = (): RealReport => {
    const statuses = report.checks.filter(check => check.status !== "INFO").map(check => check.status);
    report.overall = statuses.includes("FAIL") ? "FAIL" : statuses.length > 0 && statuses.every(status => status === "PASS") ? "PASS" : "NOT_VERIFIED";
    return report;
  };

  // ---------------------------------------------------------------- preconditions: nothing is probed unless they hold
  try {
    if ((options.platform ?? process.platform) !== "linux") throw new SafeError("linux_required");
    if (options.withLogin && env.COCKPIT_F1_ACCEPT_CONFIRMED !== "yes") throw new SafeError("confirmation_required_for_login");
    if ((await run(["systemctl", "--user", "show-environment"])).code !== 0) throw new SafeError("systemd_user_manager_unavailable");
    add("preconditions", "PASS");
  } catch (error) { add("preconditions", "NOT_VERIFIED", safeCode(error)); return finish(); }
  const os = options.facts?.osRelease ?? hostFacts().osRelease;
  add("host_is_arch", "INFO", /^ID=(?:arch|"arch"|'arch')\s*$/m.test(os) ? "arch" : "not_arch");

  // ---------------------------------------------------------------- the service's own read-only diagnosis (files, config, bun, msb, port)
  let port: number | null = null;
  let mainPid = 0;
  let active = false;
  try {
    const diagnosis = await doctor({ env, run, root });
    port = diagnosis.port; mainPid = diagnosis.state.mainPid; active = diagnosis.state.active === "active";
    for (const check of diagnosis.checks) {
      // A WARN here means "the installed service is not what this checkout would install": the acceptance would then say nothing about this commit.
      const status: RealStatus = check.status === "FAIL" ? "FAIL" : check.status === "WARN" ? "NOT_VERIFIED" : check.status === "INFO" ? "INFO" : "PASS";
      add(`doctor_${check.id}`, status, status === "PASS" ? null : check.detail);
    }
  } catch (error) { add("doctor", "NOT_VERIFIED", safeCode(error)); return finish(); }
  if (!active || mainPid <= 0 || port === null) {
    add("service_running", "NOT_VERIFIED", "service_not_active: nothing below can be probed (start it with ./scripts/cockpit service start, then run again)");
    return finish();
  }
  add("service_running", "PASS", null, { main_pid: mainPid, port });

  // ---------------------------------------------------------------- unit as loaded by systemd, and the running process
  const shown = await run(["systemctl", "--user", "show", SERVICE_UNIT, `--property=${SHOW.join(",")}`]);
  const props = Object.fromEntries(shown.stdout.split("\n").filter(line => line.includes("=")).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  const expected: Record<string, string> = { NoNewPrivileges: "yes", KillMode: "process", Restart: "on-failure", RestartPreventExitStatus: "78", UMask: "0077" };
  const wrong = Object.entries(expected).filter(([key, value]) => (key === "RestartPreventExitStatus" ? props[key]?.trim() !== value && !(props[key] ?? "").split(/\s+/).includes(value) : props[key] !== value)).map(([key]) => key);
  add("unit_hardening", wrong.length ? "FAIL" : "PASS", wrong.length ? `unexpected_${wrong.join(",")}` : null, { restart_count: Number(props.NRestarts ?? "") || 0 });

  const status = proc.status(mainPid);
  const uid = /^Uid:\s*(\d+)/m.exec(status ?? "")?.[1];
  const noNewPrivs = /^NoNewPrivs:\s*(\d)/m.exec(status ?? "")?.[1];
  if (status === null) add("process_privileges", "NOT_VERIFIED", "proc_status_unreadable");
  else if (uid === "0") add("process_privileges", "FAIL", "service_runs_as_root");
  else if (noNewPrivs !== "1") add("process_privileges", "FAIL", `no_new_privs_${noNewPrivs ?? "unreadable"}`);
  else add("process_privileges", "PASS", null, { root: false, no_new_privs: true });

  const cmdline = proc.cmdline(mainPid);
  const keys = proc.environKeys(mainPid);
  if (cmdline === null || keys === null) add("credential_not_in_process", "NOT_VERIFIED", "proc_unreadable");
  else add("credential_not_in_process", /[a-f0-9]{64}/.test(cmdline) || keys.includes("COCKPIT_LOCAL_TOKEN") ? "FAIL" : "PASS",
    /[a-f0-9]{64}/.test(cmdline) ? "credential_shape_in_argv" : keys.includes("COCKPIT_LOCAL_TOKEN") ? "credential_variable_in_environment" : null);

  const tables = proc.netTcp();
  const sockets = tables === null ? null : listeners(tables, port);
  if (sockets === null) add("loopback_only", "NOT_VERIFIED", "proc_net_unreadable");
  else add("loopback_only", sockets.length > 0 && sockets.every(kind => kind === "loopback") ? "PASS" : "FAIL", sockets.length === 0 ? "no_listener_for_port" : sockets.some(kind => kind !== "loopback") ? "listens_beyond_loopback" : null, { listeners: sockets.length });

  const group = props.ControlGroup || proc.cgroup(mainPid) || "";
  const children = group ? proc.cgroupPids(group).filter(pid => pid !== mainPid && proc.comm(pid) === "msb") : [];
  add("service_children", "INFO", null, { msb_children_in_service_cgroup: children.length });

  // ---------------------------------------------------------------- unauthenticated GETs of the service's own port (no state, no login)
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await http(`${base}/api/health`);
    const healthBody = await health.json() as Record<string, unknown>;
    const inventory = ["projects", "vms", "sessions", "runs"].filter(key => key in healthBody);
    add("http_health", health.status === 200 && healthBody.status === "ok" && inventory.length === 0 ? "PASS" : "FAIL", health.status !== 200 ? `status_${health.status}` : inventory.length ? "health_exposes_inventory" : null);
    const dashboard = await http(`${base}/api/dashboard`);
    add("http_requires_auth", dashboard.status === 401 ? "PASS" : "FAIL", dashboard.status === 401 ? null : `unauthenticated_dashboard_status_${dashboard.status}`);
    const page = await http(`${base}/`);
    const csp = page.headers.get("content-security-policy") ?? "";
    add("http_security_headers", page.status === 200 && /default-src 'none'|default-src 'self'/.test(csp) && page.headers.get("x-content-type-options") === "nosniff" && !page.headers.has("access-control-allow-origin") ? "PASS" : "FAIL",
      page.status !== 200 ? `page_status_${page.status}` : null);
  } catch (error) { add("http_health", "NOT_VERIFIED", `http_unreachable_${safeCode(error)}`); }

  // ---------------------------------------------------------------- data directory modes (stat only; the database is never opened)
  try {
    const paths = servicePaths(env);
    const values = parseEnvFile(readFileSync(paths.envFile, "utf8"));
    const settings = validateSettings(values);
    const dataDir = dirname(settings.databasePath);
    const entries = [dataDir, settings.databasePath, settings.runtimeDatabasePath, join(dirname(settings.runtimeDatabasePath), "digest.key")].filter(path => existsSync(path));
    const open = entries.filter(path => (lstatSync(path).mode & 0o077) !== 0);
    add("data_dir_private", open.length === 0 ? "PASS" : "INFO", open.length ? `group_or_other_access_on_${open.length}_of_${entries.length}_paths (data created before the service's UMask=0077 keeps its old mode)` : null, { paths_checked: entries.length });
  } catch (error) { add("data_dir_private", "NOT_VERIFIED", safeCode(error)); }

  // ---------------------------------------------------------------- journal: credential-shaped strings and refused starts
  const journal = await run(["journalctl", "--user", "-u", SERVICE_UNIT, "--no-pager", "-o", "cat", "-n", "5000"]);
  const journalText = journal.code === 0 ? journal.stdout : null;
  if (journalText === null) add("journal_clean", "NOT_VERIFIED", "journal_unreadable");
  else {
    const shaped = journalText.match(/(?<![a-f0-9])[a-f0-9]{64}(?![a-f0-9])/g) ?? [];
    add("journal_clean", shaped.length ? "FAIL" : "PASS", shaped.length ? "credential_shaped_string_in_journal" : null,
      { lines: journalText.split("\n").length, startup_failed_events: (journalText.match(/"event":"startup_failed"/g) ?? []).length });
  }

  // ---------------------------------------------------------------- opt-in: one login, one dashboard read, one logout
  if (options.withLogin) {
    try {
      const tokenPath = parseEnvFile(readFileSync(servicePaths(env).envFile, "utf8")).COCKPIT_LOCAL_TOKEN_FILE ?? servicePaths(env).tokenFile;
      const credential = readLocalCredentialFile(tokenPath);
      report.state_changed = "in_memory_session";
      const origin = base;
      const login = await http(`${base}/api/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ credential }) });
      if (login.status !== 200) throw new SafeError(`login_status_${login.status}`);
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const session = await login.json() as { proof: string; csrf: string };
      const auth = { Cookie: cookie, "X-Session-Proof": session.proof };
      try {
        const dashboard = await (await http(`${base}/api/dashboard`, { headers: auth })).json() as { reliability: Record<string, number | string> | null; attention: Array<{ kind: string }> };
        const reliability = dashboard.reliability ?? {};
        const bad = ["dispatch_unconfirmed", "transitions_rejected", "transcript_write_failed", "dispatch_failed", "approval_delivery_unconfirmed", "dispatch_blocked_orphan"].filter(key => reliability[key] !== 0);
        add("reliability_counters", dashboard.reliability === null ? "NOT_VERIFIED" : bad.length ? "FAIL" : "PASS", dashboard.reliability === null ? "reliability_unavailable" : bad.length ? `nonzero_${bad.join(",")}` : null,
          Object.fromEntries(Object.entries(reliability).filter(([, value]) => typeof value === "number")));
        const orphans = dashboard.attention.filter(item => item.kind === "orphan_process").length;
        add("orphans_visible", "INFO", null, { orphan_processes_in_attention: orphans, unknown_runs_in_attention: dashboard.attention.filter(item => item.kind === "unknown_run").length });
        add("journal_exact_credential", journalText === null ? "NOT_VERIFIED" : journalText.includes(credential) ? "FAIL" : "PASS", journalText === null ? "journal_unreadable" : journalText.includes(credential) ? "credential_in_journal" : null);
      } finally {
        await http(`${base}/api/auth/logout`, { method: "POST", headers: { ...auth, "X-CSRF-Token": session.csrf, "X-Request-Nonce": crypto.randomUUID().replaceAll("-", "") + "ac", Origin: origin, "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
      }
    } catch (error) { add("reliability_counters", "NOT_VERIFIED", safeCode(error)); }
  }
  return finish();
}

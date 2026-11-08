import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listeners, runRealReadonly, type RealProc, type RealReport } from "../src/f1-acceptance-real.ts";
import { install, servicePaths, type Runner } from "../src/service.ts";
import { fakeBun } from "./support/runtime.ts";

/**
 * The read-only real-host tier, without the real host: the installed service is a private XDG_CONFIG_HOME plus a stand-in
 * "production" HTTP server on a loopback port; systemctl/journalctl are recorded stand-ins; /proc is a table. What is proven:
 * it passes on a healthy service, fails on each hardening regression it claims to detect, stays NOT_VERIFIED when it cannot
 * probe, and — the point of the tier — it only ever issues read commands, and the opt-in login creates and revokes ONE session.
 */
const work = await mkdtemp(join(tmpdir(), "cockpit-f1-real-"));
afterAll(async () => { await rm(work, { recursive: true, force: true }); });
const bunDir = join(work, "bin");
await fakeBun(bunDir);

const READ_ONLY = (argv: readonly string[]) => (argv[0] === "systemctl" && argv[1] === "--user" && (argv[2] === "show" || argv[2] === "show-environment"))
  || (argv[0] === "journalctl" && argv.includes("--user") && !argv.some(arg => ["--rotate", "--vacuum-size", "--vacuum-time", "--flush", "--sync"].includes(arg)))
  || (argv[0] === "loginctl" && argv[1] === "show-user");

interface Fixture {
  env: Record<string, string>; port: number; token: string; calls: string[][]; requests: Array<{ method: string; path: string }>;
  run: Runner; proc: RealProc; server: Bun.Server<undefined>; unitFile: string; stop(): Promise<void>;
}
let counter = 0;
async function fixture(options: { active?: boolean; journal?: string; unauthenticatedDashboard?: number; reliability?: Record<string, number>; hardening?: Record<string, string>;
  proc?: Partial<RealProc>; csp?: boolean; listen?: "wildcard" } = {}): Promise<Fixture> {
  const configHome = join(work, `home-${++counter}`);
  await mkdir(configHome, { mode: 0o700 });
  const requests: Array<{ method: string; path: string }> = [];
  let token = "";
  let loggedIn = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const url = new URL(request.url);
    requests.push({ method: request.method, path: url.pathname });
    const headers = { "Content-Security-Policy": options.csp === false ? "script-src *" : "default-src 'none'; script-src 'self'", "X-Content-Type-Options": "nosniff" };
    if (url.pathname === "/api/health") return Response.json({ status: "ok", source: "host" }, { headers });
    if (url.pathname === "/") return new Response("<html></html>", { headers: { ...headers, "Content-Type": "text/html" } });
    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      const body = await request.json() as { credential: string };
      if (body.credential !== token) return Response.json({ error: { code: "auth_failed" } }, { status: 401 });
      loggedIn = true;
      return Response.json({ proof: "p".repeat(43), csrf: "c".repeat(43) }, { headers: { "Set-Cookie": "cockpit_session=abc; HttpOnly" } });
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") { loggedIn = false; return Response.json({ status: "logged_out" }); }
    if (url.pathname === "/api/dashboard") {
      if (!loggedIn) return Response.json({ error: { code: "unauthenticated" } }, { status: options.unauthenticatedDashboard ?? 401 });
      return Response.json({ attention: [], reliability: { since: "x", dispatch_failed: 0, dispatch_unconfirmed: 0, dispatch_blocked_orphan: 0, transitions_rejected: 0, transcript_write_failed: 0,
        approval_delivery_unconfirmed: 0, reconcile_unconfirmed: 0, runs_dispatched: 7, ...(options.reliability ?? {}) } });
    }
    return Response.json({ error: { code: "route_not_found" } }, { status: 404 });
  } });
  const port = server.port!;
  const env = { XDG_CONFIG_HOME: configHome, HOME: configHome, PATH: bunDir, COCKPIT_MODE: "mock", COCKPIT_ALLOWED_PROJECTS: "demo,lab", PORT: String(port), COCKPIT_DATA_DIR: join(configHome, "data") };
  await install({ env, run: async () => ({ code: 0, stdout: "" }) });
  const paths = servicePaths({ XDG_CONFIG_HOME: configHome });
  token = (await readFile(paths.tokenFile, "utf8")).trim();
  const calls: string[][] = [];
  const hardening = { NoNewPrivileges: "yes", KillMode: "process", Restart: "on-failure", RestartPreventExitStatus: "78", UMask: "0077", ...(options.hardening ?? {}) };
  const run: Runner = async argv => {
    calls.push([...argv]);
    if (argv.includes("show-environment")) return { code: 0, stdout: "PATH=/usr/bin\n" };
    if (argv.includes("show")) return { code: 0, stdout: [`ActiveState=${options.active === false ? "inactive" : "active"}`, "SubState=running", `MainPID=${options.active === false ? 0 : 4242}`, "Result=success", "ExecMainStatus=0",
      "NRestarts=1", "UnitFileState=enabled", `FragmentPath=${paths.unitFile}`, "ControlGroup=/user.slice/user-1000.slice/user@1000.service/app.slice/engineering-cockpit.service",
      ...Object.entries(hardening).map(([key, value]) => `${key}=${value}`)].join("\n") + "\n" };
    if (argv[0] === "journalctl") return { code: 0, stdout: options.journal ?? '{"event":"listening","url":"http://127.0.0.1:8787/"}\n{"event":"request","route":"/api/health"}\n' };
    if (argv[0] === "loginctl") return { code: 0, stdout: "Linger=no\n" };
    return { code: 1, stdout: "" };
  };
  const loopback = `  sl  local_address rem_address   st\n   0: ${options.listen === "wildcard" ? "00000000" : "0100007F"}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 1 1 0000000000000000 100 0 0 10 0\n`;
  const proc: RealProc = { status: () => "Name:\tbun\nUid:\t1000\t1000\t1000\t1000\nNoNewPrivs:\t1\n", cmdline: () => "bun --no-env-file src/index.ts", environKeys: () => ["PATH", "COCKPIT_LOCAL_TOKEN_FILE", "COCKPIT_MODE"],
    cgroup: () => "/user.slice/x/engineering-cockpit.service", cgroupPids: () => [4242, 4300], comm: pid => pid === 4300 ? "msb" : "bun", netTcp: () => [loopback, ""], ...(options.proc ?? {}) };
  return { env, port, token, calls, requests, run, proc, server, unitFile: paths.unitFile, stop: async () => { await server.stop(true); } };
}
const run = async (f: Fixture, extra: { withLogin?: boolean; env?: Record<string, string> } = {}): Promise<RealReport> => runRealReadonly({ env: { ...f.env, ...(extra.env ?? {}) }, run: f.run, proc: f.proc,
  platform: "linux", facts: { osRelease: 'NAME="Arch Linux"\nID=arch\n' }, ...(extra.withLogin ? { withLogin: true } : {}) });
const status = (report: RealReport, id: string) => report.checks.find(check => check.id === id)?.status;

test("a healthy installed service passes, and the tier only ever issues read commands and unauthenticated GETs", async () => {
  const f = await fixture();
  try {
    const report = await run(f);
    expect(report.checks.filter(check => check.status === "FAIL" || check.status === "NOT_VERIFIED")).toEqual([]);
    expect(report.overall).toBe("PASS");
    expect(report.state_changed).toBe("none");
    for (const id of ["unit_hardening", "process_privileges", "credential_not_in_process", "loopback_only", "http_health", "http_requires_auth", "http_security_headers", "journal_clean", "data_dir_private"]) expect(status(report, id)).toBe("PASS");
    expect(report.checks.find(check => check.id === "service_children")!.evidence).toEqual({ msb_children_in_service_cgroup: 1 });
    expect(f.calls.every(argv => READ_ONLY(argv))).toBe(true);
    expect(f.requests.every(request => request.method === "GET")).toBe(true);
    expect(JSON.stringify(report)).not.toContain(f.token);
  } finally { await f.stop(); }
});

test("each hardening regression it claims to detect is a FAIL; a service that is not running is NOT_VERIFIED, never PASS", async () => {
  const cases: Array<[string, Parameters<typeof fixture>[0], string]> = [
    ["no NoNewPrivileges in the unit", { hardening: { NoNewPrivileges: "no" } }, "unit_hardening"],
    ["KillMode=control-group would kill surviving orphans", { hardening: { KillMode: "control-group" } }, "unit_hardening"],
    ["restart after a refused start (78 not prevented)", { hardening: { RestartPreventExitStatus: "" } }, "unit_hardening"],
    ["the process runs as root", { proc: { status: () => "Uid:\t0\t0\t0\t0\nNoNewPrivs:\t1\n" } }, "process_privileges"],
    ["the running process lacks NoNewPrivs", { proc: { status: () => "Uid:\t1000\t1000\t1000\t1000\nNoNewPrivs:\t0\n" } }, "process_privileges"],
    ["the credential variable is in the process environment", { proc: { environKeys: () => ["PATH", "COCKPIT_LOCAL_TOKEN"] } }, "credential_not_in_process"],
    ["a credential-shaped string is on the command line", { proc: { cmdline: () => `bun src/index.ts ${"a".repeat(64)}` } }, "credential_not_in_process"],
    ["the port listens on all interfaces", { listen: "wildcard" }, "loopback_only"],
    ["a credential-shaped string is in the journal", { journal: `{"event":"x","v":"${"b".repeat(64)}"}\n` }, "journal_clean"],
    ["an unauthenticated dashboard answers 200", { unauthenticatedDashboard: 200 }, "http_requires_auth"],
    ["no restrictive CSP", { csp: false }, "http_security_headers"],
  ];
  for (const [label, options, id] of cases) {
    const f = await fixture(options);
    try {
      const report = await run(f);
      expect(`${label}: ${status(report, id)}`).toBe(`${label}: FAIL`);
      expect(report.overall).toBe("FAIL");
    } finally { await f.stop(); }
  }
  const stopped = await fixture({ active: false });
  try {
    await stopped.stop(); // a stopped service does not listen (a listener while it is inactive would itself be a FAIL: someone else holds the port)
    const report = await run(stopped);
    expect(report.overall).toBe("NOT_VERIFIED");
    expect(status(report, "service_running")).toBe("NOT_VERIFIED");
    expect(stopped.requests).toEqual([]); // nothing is probed over HTTP when the service is not active
  } finally { await stopped.stop(); }
});

test("preconditions: another platform or no user manager verify nothing", async () => {
  const f = await fixture();
  try {
    const other = await runRealReadonly({ env: f.env, run: f.run, proc: f.proc, platform: "darwin" });
    expect(other).toMatchObject({ overall: "NOT_VERIFIED", checks: [{ id: "preconditions", reason: "linux_required" }] });
    const noManager = await runRealReadonly({ env: f.env, run: async () => ({ code: 1, stdout: "" }), proc: f.proc, platform: "linux", facts: { osRelease: "ID=arch\n" } });
    expect(noManager.checks[0]).toMatchObject({ id: "preconditions", reason: "systemd_user_manager_unavailable" });
    expect(f.requests).toEqual([]);
  } finally { await f.stop(); }
});

test("the opt-in login needs the operator's confirmation; with it, exactly one login, one dashboard read and one logout — no run, session or approval", async () => {
  const f = await fixture();
  try {
    const refused = await run(f, { withLogin: true });
    expect(refused.checks[0]).toMatchObject({ id: "preconditions", status: "NOT_VERIFIED", reason: "confirmation_required_for_login" });
    expect(f.requests).toEqual([]);

    const report = await run(f, { withLogin: true, env: { COCKPIT_F1_ACCEPT_CONFIRMED: "yes" } });
    expect(report.overall).toBe("PASS");
    expect(report.state_changed).toBe("in_memory_session");
    expect(status(report, "reliability_counters")).toBe("PASS");
    expect(status(report, "journal_exact_credential")).toBe("PASS");
    const mutating = f.requests.filter(request => request.method !== "GET").map(request => `${request.method} ${request.path}`);
    expect(mutating).toEqual(["POST /api/auth/login", "POST /api/auth/logout"]);
    expect(f.requests.filter(request => request.path === "/api/dashboard" && request.method === "GET").length).toBe(2); // one unauthenticated (401) + one authenticated
    expect(f.calls.every(argv => READ_ONLY(argv))).toBe(true);
    expect(JSON.stringify(report)).not.toContain(f.token);
  } finally { await f.stop(); }
});

test("with the login: a non-zero reliability counter, or the credential in the journal, fails the acceptance", async () => {
  const bad = await fixture({ reliability: { dispatch_unconfirmed: 2 } });
  try {
    const report = await run(bad, { withLogin: true, env: { COCKPIT_F1_ACCEPT_CONFIRMED: "yes" } });
    expect(status(report, "reliability_counters")).toBe("FAIL");
    expect(report.checks.find(check => check.id === "reliability_counters")!.reason).toBe("nonzero_dispatch_unconfirmed");
    expect(report.overall).toBe("FAIL");
  } finally { await bad.stop(); }
  const leaked = await fixture();
  try {
    const token = (await readFile(servicePaths({ XDG_CONFIG_HOME: leaked.env.XDG_CONFIG_HOME }).tokenFile, "utf8")).trim();
    // The shape scan and, because the login ran, the exact value are both checked.
    const exact: Runner = async argv => argv[0] === "journalctl" ? { code: 0, stdout: `leak ${token}\n` } : leaked.run(argv);
    const report = await runRealReadonly({ env: { ...leaked.env, COCKPIT_F1_ACCEPT_CONFIRMED: "yes" }, run: exact, proc: leaked.proc, platform: "linux", facts: { osRelease: "ID=arch\n" }, withLogin: true });
    expect(status(report, "journal_clean")).toBe("FAIL");
    expect(status(report, "journal_exact_credential")).toBe("FAIL");
    expect(JSON.stringify(report)).not.toContain(token);
  } finally { await leaked.stop(); }
});

test("listeners(): loopback IPv4/IPv6/v4-mapped, wildcard and foreign addresses are told apart; only LISTEN rows of the port count", () => {
  const row = (address: string, port: number, state = "0A") => `   0: ${address}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 ${state} 0:0 00:0 0 1000 0 1 1 0`;
  const table = ["  sl", row("0100007F", 8787), row("0100007F", 8788), row("00000000", 8787), row("0A00A8C0", 8787), row("0100007F", 8787, "01"), ""].join("\n");
  expect(listeners([table], 8787)).toEqual(["loopback", "wildcard", "other"]);
  expect(listeners([["  sl", row("00000000000000000000000001000000", 8787), row("0000000000000000FFFF00000100007F", 8787), row("00000000000000000000000000000000", 8787), ""].join("\n")], 8787)).toEqual(["loopback", "loopback", "wildcard"]);
  expect(listeners(["  sl\n"], 8787)).toEqual([]);
});

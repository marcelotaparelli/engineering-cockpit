import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SMOKE_UNIT, type SmokeOptions } from "../../src/f1-systemd-smoke.ts";
import { parseEnvFile, type Runner } from "../../src/service.ts";

/**
 * A user manager and a Cockpit stand-in for the F1-D smoke and its proofs, END TO END without systemd, msb or a provider:
 * "starting" the unit serves a real HTTP API on the port the unit's own environment file names, a SIGKILL of the main process
 * stops it and "systemd" restarts it, and the `msb exec` children are real `sleep` processes (harmless: the smoke signals only
 * members of its unit's cgroup, which here is a table). The routes and response SHAPES mirror the real Cockpit's; the contract
 * test (tests/f2-proof-contract.test.ts) holds them to the real server's keys.
 *
 * Failure knobs (`World`) let a test make the Cockpit misbehave in exactly the ways the proof must catch.
 */
export interface World {
  provider: "codex" | "claude";
  vm: string;
  prompts: string[]; sessions: number; runsInSession: number;
  runStatus: string; runReason: string | null;
  orphanPid: number | null; msbPid: number | null; extraExecPid: number | null; listPid: number | null; crashes: number;
  /** What `process_kind` the surviving child is listed as. Default follows the provider (`codex_app_server` / `claude_session`). */
  orphanKind: "codex_app_server" | "claude_session" | "claude_command";
  blockSends: boolean;
  /** Pre-crash: does the persisted partial answer grow (Claude), or does the model never stream enough text? */
  partial: "grows" | "none";
  /** Post-crash: what the restarted Cockpit's history holds. */
  afterCrash: "preserved" | "shortened" | "changed" | "not_incomplete" | "missing" | "duplicated_prompt";
  blockedSendCreatesRun: boolean;
  claudeReconcileResolves: boolean;
  /** Reconcile while the surviving child lives: `refuse` is F2-M1 (orphan_owns_turn), `reattach` is the pre-F2 behaviour. */
  codexOwnerAliveReconcile: "refuse" | "reattach";
  reconcileSpawnsExec: boolean;
  /** Codex reconcile after the surviving child ended: what the (real) provider reports for the turn. */
  postRelease: "completed" | "running" | "unknown" | "still_owned";
  agentText: string; textAtCrash: string;
  /** Every request the smoke made, in order (tests add their own entries, e.g. signals, to order them against requests). */
  timeline: string[];
}

export const sleepers: Bun.Subprocess[] = [];
export function spawnSleeper(): number { const child = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); sleepers.push(child); return child.pid; }
export function killSleepers(): void { for (const child of sleepers.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } } }
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/**
 * Signals a sleeper through its Subprocess handle, NOT through `process.kill`: what the stand-in does on behalf of the Cockpit (its
 * orderly stop, a crash taking its children along) must stay apart from the signals the SMOKE sends, which a `process.kill` spy captures.
 */
export function signalSleeper(pid: number, signal: "SIGTERM" | "SIGKILL"): void { for (const child of sleepers) if (child.pid === pid) { try { child.kill(signal); } catch { /* gone */ } } }
const SESSION_UUID = "11111111-2222-4333-8444-555555555555";
const CHUNK = "linha sobre o mar... ".repeat(3); // 63 characters per history read while "streaming"
export const PARTIAL_TAIL = " <cauda persistida entre a ultima leitura e o kill>";

// ------------------------------------------------------------------------------------------------ response shapes
// Every body the stand-in serves is built here, so tests/f2-proof-contract.test.ts can hold each one to the REAL server's keys.
export const orphanItem = (w: World, pid: number) => ({ kind: "orphan_process", vm_name: w.vm, project: "demo", provider: w.provider, process_kind: w.orphanKind, pid,
  session_id: w.orphanKind === "claude_session" ? "ses-proof" : null, blocks: w.orphanKind === "codex_app_server" ? "vm" : w.orphanKind === "claude_session" ? "session" : "nothing",
  created_at: new Date().toISOString(), since: new Date().toISOString() });
export const historyUserItem = (id: string, text: string) => ({ id, runId: "run-proof", kind: "user_message", status: null, text, command: null, exitCode: null, files: [] });
export const historyAgentItem = (text: string, incomplete: boolean) => ({ id: "msg_1", runId: "run-proof", kind: "agent_message", status: "in_progress", text, command: null, exitCode: null, files: [],
  ...(incomplete ? { incomplete: true } : {}) });
export const runBody = (w: World) => ({ run_id: "run-proof", session_id: "ses-proof", status: w.runStatus, reason_code: w.runReason, provider_bound: true });
export const sessionBody = (w: World) => ({ session: { session_id: "ses-proof", vm_name: w.vm, provider: w.provider }, runs: Array.from({ length: w.runsInSession }, () => runBody(w)), approvals: [] });
export const reconcileBody = (w: World, status: string, result: string, reason: string) =>
  ({ ...runBody(w), status, reason_code: result === "confirmed" ? "reconciled" : w.runReason, reconciliation: { result, reason_code: reason } });

export class FakeSystemd {
  readonly world: World;
  state = { active: "inactive", mainPid: 0, restarts: 0, execMainStatus: 0 };
  server: Bun.Server<undefined> | null = null;
  calls: string[][] = [];
  xdg = "";
  #pids = 5000;
  constructor(readonly survivors: boolean, overrides: Partial<World> = {}, provider: "codex" | "claude" = overrides.provider ?? "codex") {
    this.world = { provider, vm: provider === "claude" ? "claude-demo" : "codex-demo", prompts: [], sessions: 0, runsInSession: 0, runStatus: "running", runReason: null,
      orphanPid: null, msbPid: null, extraExecPid: null, listPid: null, crashes: 0, orphanKind: provider === "claude" ? "claude_session" : "codex_app_server",
      blockSends: true, partial: "grows", afterCrash: "preserved", blockedSendCreatesRun: false, claudeReconcileResolves: false, codexOwnerAliveReconcile: "refuse",
      reconcileSpawnsExec: false, postRelease: "completed", agentText: "", textAtCrash: "", timeline: [], ...overrides };
  }
  unitFile = () => join(this.xdg, "systemd/user", SMOKE_UNIT);
  #settings() {
    const unit = readFileSync(this.unitFile(), "utf8");
    const envFile = /^EnvironmentFile=(\S+)/m.exec(unit)![1]!;
    const values = parseEnvFile(readFileSync(envFile, "utf8"));
    return { port: Number(values.PORT), tokenFile: values.COCKPIT_LOCAL_TOKEN_FILE! };
  }
  #ownerAlive(): boolean { const w = this.world; return w.orphanPid !== null && alive(w.orphanPid) && w.orphanKind !== "claude_command"; }
  #serve() {
    const { port, tokenFile } = this.#settings();
    const token = readFileSync(tokenFile, "utf8").trim();
    const session = crypto.randomUUID().replaceAll("-", "");
    const world = this.world;
    const authed = (request: Request) => request.headers.get("cookie") === `cockpit_session=${session}` && request.headers.get("x-session-proof") === `proof-${session}`;
    const ensureChild = () => { if (!world.msbPid || !alive(world.msbPid)) world.msbPid = spawnSleeper(); };
    this.server = Bun.serve({ hostname: "127.0.0.1", port, fetch: async request => {
      const url = new URL(request.url);
      if (url.pathname === "/api/health") return Response.json({ status: "ok" });
      if (url.pathname === "/api/auth/login") {
        const body = await request.json() as { credential: string };
        if (body.credential !== token) return Response.json({ error: { code: "auth_failed" } }, { status: 401 });
        return Response.json({ proof: `proof-${session}`, csrf: "csrf-" + session }, { headers: { "Set-Cookie": `cockpit_session=${session}; HttpOnly` } });
      }
      if (!authed(request)) return Response.json({ error: { code: "unauthenticated" } }, { status: 401 });
      world.timeline.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/api/dashboard") {
        const orphan = world.orphanPid !== null && alive(world.orphanPid) ? [orphanItem(world, world.orphanPid)] : [];
        return Response.json({ discovery_error: null, vms: [{ vm_name: world.vm, vm_state: "running" }], attention: orphan });
      }
      if (url.pathname === `/api/vms/${world.vm}/threads`) { ensureChild(); return Response.json({ vm_name: world.vm, threads: [] }); }
      if (url.pathname === "/api/sessions" && request.method === "POST") { world.sessions++; return Response.json({ session_id: "ses-proof" }, { status: 201 }); }
      if (url.pathname === "/api/sessions/ses-proof" && request.method === "GET") {
        return Response.json(sessionBody(world));
      }
      if (url.pathname === "/api/sessions/ses-proof/runs" && request.method === "POST") {
        const blockedNow = world.blockSends && this.#ownerAlive();
        if (blockedNow) { if (world.blockedSendCreatesRun) world.runsInSession++; return Response.json({ error: { code: "orphan_process_alive" } }, { status: 409 }); }
        world.prompts.push(((await request.json()) as { prompt: string }).prompt);
        world.runsInSession++;
        ensureChild();
        return Response.json({ run_id: "run-proof", status: "running" }, { status: 202 });
      }
      if (url.pathname === "/api/sessions/ses-proof/history" && request.method === "GET") {
        const preCrash = world.crashes === 0;
        if (preCrash && world.partial === "grows") world.agentText += CHUNK;
        const user = (id: string) => historyUserItem(id, world.prompts[0] ?? "(prompt)");
        const items: unknown[] = [user("run-proof:prompt")];
        const agent = historyAgentItem;
        if (preCrash) { if (world.agentText) items.push(agent(world.agentText, false)); }
        else {
          const kept = world.textAtCrash;
          switch (world.afterCrash) {
            case "preserved": items.push(agent(kept + PARTIAL_TAIL, true)); break;
            case "shortened": items.push(agent(kept.slice(0, -10), true)); break;
            case "changed": items.push(agent("X" + kept.slice(1), true)); break;
            case "not_incomplete": items.push(agent(kept + PARTIAL_TAIL, false)); break;
            case "missing": break;
            case "duplicated_prompt": items.push(agent(kept + PARTIAL_TAIL, true), user("run-proof:prompt-again")); break;
          }
        }
        return Response.json({ session_id: "ses-proof", items, runs: [], next_cursor: null });
      }
      if (url.pathname === "/api/runs/run-proof" && request.method === "GET") return Response.json(runBody(world));
      if (url.pathname === "/api/runs/run-proof/reconcile" && request.method === "POST") {
        if (world.reconcileSpawnsExec && this.#ownerAlive()) world.extraExecPid = spawnSleeper();
        const view = (status: string, result: string, reason: string) => Response.json(reconcileBody(world, status, result, reason));
        if (world.provider === "claude") return world.claudeReconcileResolves ? view("completed", "confirmed", "reconciled") : view("unknown", "unconfirmed", "provider_cannot_confirm");
        if (this.#ownerAlive()) return world.codexOwnerAliveReconcile === "refuse" ? view("unknown", "unconfirmed", "orphan_owns_turn") : view("running", "confirmed", "reconciled");
        switch (world.postRelease) {
          case "completed": return view("completed", "confirmed", "reconciled");
          case "running": return view("running", "confirmed", "reconciled");
          case "unknown": return view("unknown", "unconfirmed", "provider_reports_unknown");
          case "still_owned": return view("unknown", "unconfirmed", "orphan_owns_turn");
        }
      }
      return Response.json({ error: { code: "route_not_found" } }, { status: 404 });
    } });
  }
  #start(): boolean {
    const { tokenFile } = this.#settings();
    if ((statSync(tokenFile).mode & 0o077) !== 0) { this.state = { ...this.state, active: "failed", mainPid: 0, execMainStatus: 78 }; return false; } // the Cockpit refuses a readable credential
    this.#serve();
    this.state = { ...this.state, active: "active", mainPid: ++this.#pids, execMainStatus: 0 };
    return true;
  }
  async #stopServer() { if (this.server) { await this.server.stop(true); this.server = null; } }
  /** SIGKILL of the main process: the server dies, the unit restarts it; a child survives only in the "survivors" scenario. */
  async #crash() {
    await this.#stopServer();
    const w = this.world;
    w.crashes++;
    w.textAtCrash = w.agentText;
    w.runStatus = "unknown";
    w.runReason = "process_restarted";
    if (w.msbPid && alive(w.msbPid)) { if (this.survivors) w.orphanPid = w.msbPid; else signalSleeper(w.msbPid, "SIGKILL"); }
    w.msbPid = null;
    this.state.restarts++;
    this.state.active = "activating";
    await Bun.sleep(150);
    this.#start();
  }
  cgroupPids = (): number[] => this.state.active === "active"
    ? [this.state.mainPid, ...[this.world.msbPid, this.world.orphanPid, this.world.extraExecPid, this.world.listPid].filter((pid): pid is number => pid !== null && alive(pid))] : [];
  run: Runner = async argv => {
    this.calls.push([...argv]);
    if (argv[0] === "journalctl") return { code: 0, stdout: '{"event":"listening","url":"http://127.0.0.1:1/"}\n' };
    const [, , command, ...rest] = argv;
    switch (command) {
      case "show-environment": return { code: 0, stdout: "PATH=/usr/bin\n" };
      case "show": return { code: 0, stdout: [`FragmentPath=${this.unitFile()}`, `ActiveState=${this.state.active}`, `MainPID=${this.state.mainPid}`, `NRestarts=${this.state.restarts}`, `ExecMainStatus=${this.state.execMainStatus}`,
        `SubState=${this.state.active === "active" ? "running" : "dead"}`, "Result=success", `ControlGroup=/user.slice/${SMOKE_UNIT}`, "NoNewPrivileges=yes", "KillMode=process", "Restart=on-failure", "RestartPreventExitStatus=78"].join("\n") + "\n" };
      case "start": return { code: this.#start() ? 0 : 1, stdout: "" };
      case "stop": await this.#stopServer(); this.state.active = "inactive"; this.state.mainPid = 0; this.state.execMainStatus = 0;
        // the Cockpit ends its own children on an orderly stop
        for (const pid of [this.world.msbPid, this.world.extraExecPid, this.world.listPid]) if (pid && alive(pid)) signalSleeper(pid, "SIGTERM"); // a real `msb list` is short-lived and gone by then
        return { code: 0, stdout: "" };
      case "kill":
        if (rest.includes("--kill-whom=main")) { void this.#crash(); return { code: 0, stdout: "" }; }
        await this.#stopServer(); this.state.active = "inactive"; this.state.mainPid = 0; return { code: 0, stdout: "" };
      default: return { code: 0, stdout: "" };
    }
  };
  #execArgv(pid: number): string[] | null {
    const w = this.world;
    if (pid === w.listPid) return ["msb", "list", "--format", "json"];
    if (pid !== w.msbPid && pid !== w.orphanPid && pid !== w.extraExecPid) return null;
    if (w.provider === "codex") return ["msb", "exec", "--stream", w.vm, "--", "codex", "app-server", "--listen", "stdio://"];
    // /proc shows whatever argv[0] the parent used: a full path here exercises the basename normalisation of the smoke.
    return pid === w.orphanPid && w.orphanKind === "claude_command"
      ? ["/usr/bin/msb", "exec", "--stream", w.vm, "--", "claude", "--version"]
      : ["/usr/bin/msb", "exec", "--stream", w.vm, "--", "claude", "-p", "--input-format", "stream-json", "--session-id", SESSION_UUID];
  }
  proc: NonNullable<SmokeOptions["proc"]> = {
    mainNoNewPrivs: () => true,
    cgroupPids: () => this.cgroupPids(),
    isMsb: pid => pid === this.world.msbPid || pid === this.world.orphanPid || pid === this.world.extraExecPid || pid === this.world.listPid,
    alive,
    inGroup: (pid, group) => group.endsWith(`/${SMOKE_UNIT}`) && this.cgroupPids().includes(pid),
    argv: pid => this.#execArgv(pid),
  };
}

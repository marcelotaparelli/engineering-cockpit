import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROOF_PROBE_PROMPT, PROOF_PROMPT, runSystemdSmoke, SMOKE_CHECK_IDS, SMOKE_PROOF_CHECK_IDS, SMOKE_UNIT, type SmokeOptions, type SmokeReport } from "../src/f1-systemd-smoke.ts";
import { parseEnvFile, type Runner } from "../src/service.ts";
import { bareRoot, fakeBun } from "./support/runtime.ts";

/**
 * The F1-D smoke and its F1-P1 proof mode, END TO END without systemd, msb or a provider: a user manager stand-in that "starts"
 * and "kills" a stand-in Cockpit (a real HTTP server driven by the unit's own environment file), and real `sleep` processes as
 * the `msb exec` children (harmless: the smoke signals only members of its unit's cgroup, which here is a table). What is proven:
 * the smoke's whole sequence works against the API it will meet on the Arch host, the proof mode sends exactly the prompts it
 * declares, fails when a send is not blocked, stays NOT_VERIFIED when no child survives, and refuses to run without BOTH confirmations.
 * What is NOT proven here: that a real `msb` child survives a real SIGKILL under systemd (only the operator's run can say).
 */
const work = await mkdtemp(join(tmpdir(), "cockpit-f1-proof-"));
const sleepers: Bun.Subprocess[] = [];
afterAll(async () => { for (const child of sleepers) { try { child.kill("SIGKILL"); } catch { /* gone */ } } await rm(work, { recursive: true, force: true }); });
const bin = join(work, "bin");
await fakeBun(bin);
await writeFile(join(bin, "msb"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
let counter = 0;

interface World { prompts: string[]; sessions: number; runStatus: string; orphanPid: number | null; blockSends: boolean; msbPid: number | null; crashes: number }
function spawnSleeper(): number { const child = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); sleepers.push(child); return child.pid; }
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

class FakeSystemd {
  readonly world: World = { prompts: [], sessions: 0, runStatus: "running", orphanPid: null, blockSends: true, msbPid: null, crashes: 0 };
  state = { active: "inactive", mainPid: 0, restarts: 0, execMainStatus: 0 };
  server: Bun.Server<undefined> | null = null;
  calls: string[][] = [];
  xdg = "";
  #pids = 5000;
  constructor(readonly survivors: boolean) {}
  unitFile = () => join(this.xdg, "systemd/user", SMOKE_UNIT);
  #settings() {
    const unit = readFileSync(this.unitFile(), "utf8");
    const envFile = /^EnvironmentFile=(\S+)/m.exec(unit)![1]!;
    const values = parseEnvFile(readFileSync(envFile, "utf8"));
    return { port: Number(values.PORT), tokenFile: values.COCKPIT_LOCAL_TOKEN_FILE! };
  }
  #serve() {
    const { port, tokenFile } = this.#settings();
    const token = readFileSync(tokenFile, "utf8").trim();
    const session = crypto.randomUUID().replaceAll("-", "");
    const world = this.world;
    const authed = (request: Request) => request.headers.get("cookie") === `cockpit_session=${session}` && request.headers.get("x-session-proof") === `proof-${session}`;
    this.server = Bun.serve({ hostname: "127.0.0.1", port, fetch: async request => {
      const url = new URL(request.url);
      if (url.pathname === "/api/health") return Response.json({ status: "ok" });
      if (url.pathname === "/api/auth/login") {
        const body = await request.json() as { credential: string };
        if (body.credential !== token) return Response.json({ error: { code: "auth_failed" } }, { status: 401 });
        return Response.json({ proof: `proof-${session}`, csrf: "csrf-" + session }, { headers: { "Set-Cookie": `cockpit_session=${session}; HttpOnly` } });
      }
      if (!authed(request)) return Response.json({ error: { code: "unauthenticated" } }, { status: 401 });
      if (url.pathname === "/api/dashboard") {
        const orphan = world.orphanPid !== null && alive(world.orphanPid) ? [{ kind: "orphan_process", pid: world.orphanPid }] : [];
        return Response.json({ discovery_error: null, vms: [{ vm_name: "codex-demo", vm_state: "running" }], attention: orphan });
      }
      if (url.pathname === "/api/vms/codex-demo/threads") { if (!world.msbPid || !alive(world.msbPid)) world.msbPid = spawnSleeper(); return Response.json({ vm_name: "codex-demo", threads: [] }); }
      if (url.pathname === "/api/sessions" && request.method === "POST") { world.sessions++; return Response.json({ session_id: "ses-proof" }, { status: 201 }); }
      if (url.pathname === "/api/sessions/ses-proof/runs" && request.method === "POST") {
        if (world.blockSends && world.orphanPid !== null && alive(world.orphanPid)) return Response.json({ error: { code: "orphan_process_alive" } }, { status: 409 });
        world.prompts.push(((await request.json()) as { prompt: string }).prompt);
        if (!world.msbPid || !alive(world.msbPid)) world.msbPid = spawnSleeper();
        return Response.json({ run_id: "run-proof", status: "running" }, { status: 202 });
      }
      if (url.pathname === "/api/runs/run-proof") return Response.json({ run_id: "run-proof", status: world.runStatus });
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
    this.world.crashes++;
    this.world.runStatus = "unknown";
    if (this.world.msbPid && alive(this.world.msbPid)) { if (this.survivors) this.world.orphanPid = this.world.msbPid; else process.kill(this.world.msbPid, "SIGKILL"); }
    this.world.msbPid = null;
    this.state.restarts++;
    this.state.active = "activating";
    await Bun.sleep(150);
    this.#start();
  }
  cgroupPids = (): number[] => this.state.active === "active" ? [this.state.mainPid, ...[this.world.msbPid, this.world.orphanPid].filter((pid): pid is number => pid !== null && alive(pid))] : [];
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
        if (this.world.msbPid && alive(this.world.msbPid)) process.kill(this.world.msbPid, "SIGTERM");
        return { code: 0, stdout: "" };
      case "kill":
        if (rest.includes("--kill-whom=main")) { void this.#crash(); return { code: 0, stdout: "" }; }
        await this.#stopServer(); this.state.active = "inactive"; this.state.mainPid = 0; return { code: 0, stdout: "" };
      default: return { code: 0, stdout: "" };
    }
  };
  proc: NonNullable<SmokeOptions["proc"]> = {
    mainNoNewPrivs: () => true,
    cgroupPids: () => this.cgroupPids(),
    isMsb: pid => pid === this.world.msbPid || pid === this.world.orphanPid,
    alive,
    inGroup: (pid, group) => group.endsWith(`/${SMOKE_UNIT}`) && this.cgroupPids().includes(pid),
  };
}

async function smoke(options: { survivors: boolean; proof: boolean; quota?: boolean; blockSends?: boolean }): Promise<{ report: SmokeReport; fake: FakeSystemd; xdg: string; root: string }> {
  const fake = new FakeSystemd(options.survivors);
  fake.world.blockSends = options.blockSends ?? true;
  const xdg = join(work, `run-${++counter}`);
  await mkdir(xdg, { mode: 0o700 });
  fake.xdg = xdg;
  const root = await bareRoot(join(work, `root-${counter}`), "none"); // never the real checkout
  const env = { COCKPIT_F1_SMOKE_CONFIRMED: "yes", COCKPIT_SMOKE_VM: "codex-demo", COCKPIT_PROJECTS_BASE: "/srv/projects", XDG_RUNTIME_DIR: xdg, PATH: bin,
    ...(options.proof ? { COCKPIT_SMOKE_ORPHAN_PROOF: "yes" } : {}), ...(options.quota ? { COCKPIT_SMOKE_QUOTA_CONFIRMED: "yes" } : {}) };
  const report = await runSystemdSmoke({ env, run: fake.run, proc: fake.proc, root, timeoutsMs: { start: 5000, restart: 8000, settle: 700 }, onInterrupt: () => () => {} });
  return { report, fake, xdg, root };
}
const statuses = (report: SmokeReport) => Object.fromEntries(report.checks.map(check => [check.id, check.status]));

test("end to end without the proof: every check passes except the orphan ledger, which is NOT_VERIFIED when no msb child survives the crash", async () => {
  const { report, fake, xdg } = await smoke({ survivors: false, proof: false });
  expect(report.checks.map(check => check.id)).toEqual([...SMOKE_CHECK_IDS]);
  expect(statuses(report)).toEqual({ ...Object.fromEntries(SMOKE_CHECK_IDS.map(id => [id, "PASS"])), orphan_ledger: "NOT_VERIFIED" });
  expect(report.overall).toBe("NOT_VERIFIED");
  expect(fake.world.prompts).toEqual([]); // the default smoke sends no prompt at all
  expect(fake.world.sessions).toBe(0);
  expect(await readdir(join(xdg, "systemd/user"))).toEqual([]); // the runtime unit is gone
});

test("end to end, a surviving child without the proof: the ledger lists it and the smoke ends it", async () => {
  const { report, fake } = await smoke({ survivors: true, proof: false });
  expect(statuses(report).orphan_ledger).toBe("PASS");
  expect(report.overall).toBe("PASS");
  expect(fake.world.orphanPid !== null && alive(fake.world.orphanPid)).toBe(false); // terminated by the smoke, not left behind
});

test("F1-P1 proof: refuses to run without BOTH confirmations, and creates nothing", async () => {
  const { report, fake, xdg } = await smoke({ survivors: true, proof: true, quota: false });
  expect(report.overall).toBe("NOT_VERIFIED");
  expect(report.checks[0]).toMatchObject({ id: "preconditions", status: "NOT_VERIFIED", reason: "quota_confirmation_required" });
  expect(fake.calls.filter(argv => ["start", "daemon-reload", "kill", "stop"].includes(argv[2] ?? ""))).toEqual([]);
  expect(await readdir(xdg)).toEqual([]);
});

test("F1-P1 proof: one real turn is started, the crash leaves an orphan, the ledger lists it, a send is refused, ending it releases the block", async () => {
  const { report, fake } = await smoke({ survivors: true, proof: true, quota: true });
  expect(report.checks.map(check => check.id)).toEqual([...SMOKE_CHECK_IDS, ...SMOKE_PROOF_CHECK_IDS]);
  expect(statuses(report)).toEqual(Object.fromEntries([...SMOKE_CHECK_IDS, ...SMOKE_PROOF_CHECK_IDS].map(id => [id, "PASS"])));
  expect(report.overall).toBe("PASS");
  // Exactly one prompt reached the service: the long one. The probe was refused (409) and never accepted.
  expect(fake.world.prompts).toEqual([PROOF_PROMPT]);
  expect(PROOF_PROBE_PROMPT).not.toBe(PROOF_PROMPT);
  expect(fake.world.sessions).toBe(1);
  expect(report.checks.find(check => check.id === "run_unknown_after_crash")!.evidence).toMatchObject({ status: "unknown" });
  expect(report.checks.find(check => check.id === "orphan_blocks_send")!.evidence).toEqual({ status: 409, error_code: "orphan_process_alive" });
  expect(JSON.stringify(report)).not.toContain(PROOF_PROMPT); // the prompt text is not in the evidence
});

test("F1-P1 proof: a send accepted while an orphan is alive is a FAIL (the block is the whole point)", async () => {
  const { report, fake } = await smoke({ survivors: true, proof: true, quota: true, blockSends: false });
  expect(statuses(report).orphan_blocks_send).toBe("FAIL");
  expect(report.checks.find(check => check.id === "orphan_blocks_send")!.reason).toMatch(/^send_not_blocked_202/);
  expect(report.overall).toBe("FAIL");
  expect(fake.world.prompts).toEqual([PROOF_PROMPT, PROOF_PROBE_PROMPT]); // and the harmless probe is the only extra prompt
});

test("F1-P1 proof: when no msb child survives, the orphan checks are NOT_VERIFIED (never PASS) and the run is still left unknown", async () => {
  const { report } = await smoke({ survivors: false, proof: true, quota: true });
  const s = statuses(report);
  expect(s).toMatchObject({ orphan_turn_started: "PASS", crash_restart: "PASS", run_unknown_after_crash: "PASS", orphan_ledger: "NOT_VERIFIED", orphan_blocks_send: "NOT_VERIFIED", orphan_released: "NOT_VERIFIED", cleanup: "PASS" });
  expect(report.overall).toBe("NOT_VERIFIED");
});

test("cleanup is complete after every end-to-end run: no unit file, no work directory, no process left in the cgroup", async () => {
  const { fake, root } = await smoke({ survivors: true, proof: true, quota: true });
  expect(fake.cgroupPids()).toEqual([]);
  const base = join(root, ".cache", "f1-systemd-smoke");
  expect(await readdir(base)).toEqual([]);
});

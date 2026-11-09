import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore, type RunRecord } from "../src/runtime-store.ts";
import { ProcessLedger, type OrphanProcess } from "../src/process-ledger.ts";
import { ExecutionService, type ExecutionLog } from "../src/execution.ts";
import { CodexAppServerAdapter } from "../src/codex-adapter.ts";
import { FakeCodexTransport, FakeCodexWorld } from "../src/fake-codex.ts";
import { EventHub } from "../src/event-hub.ts";
import { LocalSecurity } from "../src/local-security.ts";
import { startServer } from "../src/server.ts";
import type { MsbChild, MsbSpawn } from "../src/msb-transport.ts";
import type { Snapshot } from "../src/model.ts";

/**
 * F2 (L4, decision D10) — a Codex run left `unknown` while the app-server of the previous Cockpit is still alive on the VM.
 *
 * Before F2, `reconcile` opened a SECOND app-server beside the orphan, read the turn as `running` and reattached the run to that
 * new connection: no event of the orphan's turn ever reached it, interrupt went nowhere and the project stayed locked until the
 * orphan ended (E4 §10). Now the run stays `unknown` with `orphan_owns_turn`, nothing is spawned, and the normal path resumes as
 * soon as the operator ends the orphan.
 *
 * The orphan is a REAL process (`sleep`) recorded by a "crashed" ledger, so liveness comes from the real /proc; the provider is
 * the deterministic fake App Server, whose world (threads, turns) survives the Cockpit like the VM does.
 */
const credential = "f".repeat(64);
const CODEX_ARGV = (vm: string) => ["msb", "exec", "--stream", vm, "--", "codex", "app-server", "--listen", "stdio://"];
const quiet = () => {};
const children: Bun.Subprocess[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } await child.exited; }
});

/** Runs `sleep` whatever the msb argv says: a real, controllable stand-in for the surviving `msb exec … codex app-server`. */
const sleepSpawn: MsbSpawn = () => {
  const child = Bun.spawn(["sleep", "60"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  children.push(child);
  return child as unknown as MsbChild;
};
async function deadIdentity(): Promise<{ pid: number; startTicks: string }> {
  const gone = Bun.spawn(["true"]);
  await gone.exited;
  return { pid: gone.pid, startTicks: "1" };
}
async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timeout; last=${JSON.stringify(value)}`);
    await Bun.sleep(10);
  }
}

const snapshot = (): Snapshot => ({ source: "mock", host_verification: "not_verified", observed_at: new Date().toISOString(), projects: ["alpha", "beta"],
  vms: [
    { vm_name: "codex-alpha", project: "alpha", provider: "codex", state: "running", orphaned: false },
    { vm_name: "codex-beta", project: "beta", provider: "codex", state: "running", orphaned: false },
  ] });

/** One "VM" world per VM name, shared by every Cockpit instance of a test (the provider state outlives the Cockpit). */
function cockpit(store: RuntimeStore, worlds: Map<string, FakeCodexWorld>, processes?: ConstructorParameters<typeof ExecutionService>[0]["processes"]) {
  const transports: Array<{ vmName: string; transport: FakeCodexTransport }> = [];
  const logs: ExecutionLog[] = [];
  const adapter = new CodexAppServerAdapter(target => {
    let world = worlds.get(target.vmName);
    if (!world) { world = new FakeCodexWorld(); worlds.set(target.vmName, world); }
    const transport = new FakeCodexTransport(world, { delayMs: 2 });
    transports.push({ vmName: target.vmName, transport });
    return transport;
  });
  const execution = new ExecutionService({ store, adapter, hub: new EventHub(), refresh: async () => snapshot(), log: entry => { logs.push(entry); }, ...(processes ? { processes } : {}) });
  cleanups.push(() => execution.close());
  return { execution, transports, logs };
}

async function tempStore(): Promise<{ path: string; open: () => RuntimeStore }> {
  const dir = await mkdtemp(join(tmpdir(), "cockpit-f2-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "runtime", "runtime.sqlite");
  return { path, open: () => { const store = new RuntimeStore(path); cleanups.push(() => store.close()); return store; } };
}

/** A Codex turn still in progress on the VM: the fake App Server keeps an "elicit" turn open until it is interrupted. */
async function turnInFlight(execution: ExecutionService, store: RuntimeStore, vmName = "codex-alpha", project = "alpha") {
  const target = await execution.revalidate(vmName, project);
  const session = await execution.openSession(target, "new");
  const { run } = await execution.startRun(session, "elicit: tarefa longa que segue rodando na VM", `key-${crypto.randomUUID()}`);
  const bound = await until(() => store.getRun(run.runId)!, value => value.status === "running" && value.providerRunId !== null);
  return { session, run: bound };
}
const turnStatus = (world: FakeCodexWorld, run: RunRecord) =>
  [...world.threads.values()].flatMap(thread => thread.turns).find(turn => turn.id === run.providerRunId)?.status;

describe.skipIf(process.platform !== "linux")("F2 (L4/D10): reconcile never reattaches a run owned by an orphaned Codex app-server", () => {
  test("Cockpit crash with a turn in flight: the restarted Cockpit keeps the run unknown (orphan_owns_turn), spawns nothing, locks nothing; ending the orphan restores the normal path", async () => {
    const worlds = new Map<string, FakeCodexWorld>();
    const db = await tempStore();
    // --- Cockpit #1: a real turn in flight; its app-server child (the `sleep`) is in the ledger under an owner that then dies.
    const first = db.open();
    const before = cockpit(first, worlds);
    const { session, run } = await turnInFlight(before.execution, first);
    const crashed = new ProcessLedger(first, { self: await deadIdentity(), log: quiet });
    const orphan = crashed.track(sleepSpawn)(CODEX_ARGV("codex-alpha"), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} });
    // kill -9 of Cockpit #1: nothing is closed in order, so the turn is NOT interrupted on the VM.
    before.transports[0]!.transport.crash();
    await until(() => first.getRun(run.runId)!.status, status => status === "unknown"); // Cockpit #1 is now inert
    const world = worlds.get("codex-alpha")!;
    const turnsBefore = world.turnStarts;
    expect(turnStatus(world, run)).toBe("inProgress");

    // --- Cockpit #2 opens the same database: startup recovery classifies the surviving child as an orphan.
    const store = db.open();
    const ledger = new ProcessLedger(store, { log: quiet });
    expect(ledger.recover()).toMatchObject({ orphans: 1 });
    const after = cockpit(store, worlds, ledger);
    const recovered = store.getRun(run.runId)!;
    expect(recovered.status).toBe("unknown");

    // Reconcile over real HTTP, as the "Reconciliar" button does.
    const server = startServer({ source: "mock", port: 0, security: new LocalSecurity(credential, ["alpha"]), runtime: store, execution: after.execution,
      hub: new EventHub(), discovery: { refresh: async () => snapshot() }, log: quiet });
    cleanups.push(() => { server.stop(true); });
    const base = server.url.toString();
    const origin = base.slice(0, -1);
    const login = await fetch(base + "api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ credential }) });
    const auth = await login.json() as { proof: string; csrf: string };
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const reconcile = () => fetch(`${base}api/runs/${run.runId}/reconcile`, { method: "POST", body: "{}", headers: { Cookie: cookie, "X-Session-Proof": auth.proof,
      "X-CSRF-Token": auth.csrf, "X-Request-Nonce": crypto.randomUUID().replaceAll("-", "") + "xx", Origin: origin, "Content-Type": "application/json" } });

    const refused = await reconcile();
    expect(refused.status).toBe(200);
    expect(await refused.json()).toMatchObject({ run_id: run.runId, status: "unknown", reconciliation: { result: "unconfirmed", reason_code: "orphan_owns_turn" } });
    // Nothing was spawned beside the orphan, nothing was sent, nothing is locked, the run did not move.
    expect(after.transports).toEqual([]);
    expect(world.turnStarts).toBe(turnsBefore);
    expect(store.getRun(run.runId)).toMatchObject({ status: "unknown", lifecycleVersion: recovered.lifecycleVersion, reasonCode: recovered.reasonCode });
    expect(store.activeRunForProject("alpha")).toBeNull();
    expect(after.execution.reliability()).toMatchObject({ reconcile_unconfirmed: 1, reconcile_confirmed: 0, active_runs: 0, provider_connections: 0, orphan_processes: 1 });
    expect(after.logs).toContainEqual(expect.objectContaining({ event: "run.reconciled", run_id: run.runId, outcome: "unconfirmed", reason_code: "orphan_owns_turn" }));
    // Repeating the click changes nothing (still re-probed, still refused).
    expect(await (await reconcile()).json()).toMatchObject({ status: "unknown", reconciliation: { reason_code: "orphan_owns_turn" } });
    expect(after.transports).toEqual([]);
    // A new prompt on that VM stays refused too (E4 rule, unchanged).
    await expect(after.execution.startRun(store.getSession(session.sessionId)!, "outra tarefa", `key-${crypto.randomUUID()}`)).rejects.toThrow("orphan_process_alive");

    // --- The orphan finishes the turn on the VM and the operator ends it (`kill <pid>`): the next reconcile asks the provider.
    const owned = [...world.threads.values()].flatMap(thread => thread.turns).find(turn => turn.id === run.providerRunId)!;
    owned.status = "completed";
    orphan.kill("SIGKILL");
    await orphan.exited;
    const released = await (await reconcile()).json();
    expect(released).toMatchObject({ status: "completed", reason_code: "reconciled", reconciliation: { result: "confirmed", reason_code: "reconciled" } });
    expect(after.transports.map(item => item.vmName)).toEqual(["codex-alpha"]); // one read-only connection, only now
    expect(world.turnStarts).toBe(turnsBefore); // and still nothing resent
    expect(ledger.orphans()).toEqual([]);
  });

  test("only an app-server orphan of the SAME VM holds the run: an orphan on another VM, or a non-Codex orphan, changes nothing", async () => {
    const worlds = new Map<string, FakeCodexWorld>();
    const db = await tempStore();
    const store = db.open();
    let orphans: OrphanProcess[] = [];
    const processes = { orphans: () => orphans, blocking: () => null };
    const h = cockpit(store, worlds, processes);
    const { session, run } = await turnInFlight(h.execution, store);
    h.transports[0]!.transport.crash();
    await until(() => store.getRun(run.runId)!.status, status => status === "unknown");
    const owned = [...worlds.get("codex-alpha")!.threads.values()].flatMap(thread => thread.turns).find(turn => turn.id === run.providerRunId)!;
    owned.status = "completed";
    const since = new Date().toISOString();
    orphans = [
      { pid: 999_001, kind: "codex_app_server", vmName: "codex-beta", providerSessionId: null, since, detectedAt: since },
      { pid: 999_002, kind: "claude_session", vmName: "codex-alpha", providerSessionId: session.providerSessionId, since, detectedAt: since },
      { pid: 999_003, kind: "claude_command", vmName: "codex-alpha", providerSessionId: null, since, detectedAt: since },
    ];
    const result = await h.execution.reconcile(store.getRun(run.runId)!, session);
    expect(result.outcome).toEqual({ result: "confirmed", reasonCode: "reconciled" });
    expect(result.run.status).toBe("completed");
  });

  test("the cheaper verdicts come first: a run with no provider id still reports provider_run_unbound, a run that is not unknown is not touched, and neither probes the ledger", async () => {
    const worlds = new Map<string, FakeCodexWorld>();
    const db = await tempStore();
    const store = db.open();
    const since = new Date().toISOString();
    let probes = 0;
    const processes = { orphans: () => { probes++; return [{ pid: 999_004, kind: "codex_app_server" as const, vmName: "codex-alpha", providerSessionId: null, since, detectedAt: since }]; }, blocking: () => null };
    const h = cockpit(store, worlds, processes);
    const target = await h.execution.revalidate("codex-alpha", "alpha");
    const session = await h.execution.openSession(target, "new");
    const at = new Date().toISOString();
    const { run } = store.beginRun({ runId: "run-unbound", sessionId: session.sessionId, idempotencyKey: "key-unbound", requestDigest: "d".repeat(64), createdAt: at });
    store.transition(run.runId, 1, "dispatching", at);
    store.transition(run.runId, 2, "unknown", at, { reasonCode: "dispatch_unconfirmed" });
    expect((await h.execution.reconcile(store.getRun(run.runId)!, session)).outcome).toEqual({ result: "unconfirmed", reasonCode: "provider_run_unbound" });

    const { run: other } = store.beginRun({ runId: "run-running", sessionId: session.sessionId, idempotencyKey: "key-running", requestDigest: "e".repeat(64), createdAt: at });
    expect((await h.execution.reconcile(other, session)).outcome).toEqual({ result: "not_applicable", reasonCode: "run_not_unknown" });
    expect(probes).toBe(0);
  });
  test("a ledger that cannot be read proves nothing: a Codex reconcile fails closed (orphan_check_unavailable) and contacts no provider, while the dashboard read stays non-fatal", async () => {
    const worlds = new Map<string, FakeCodexWorld>();
    const db = await tempStore();
    const store = db.open();
    // The ledger reads through its own handle of the same database; closing that handle makes every ledger read throw.
    const broken = new RuntimeStore(db.path);
    const ledger = new ProcessLedger(broken, { log: quiet });
    const h = cockpit(store, worlds, ledger);
    const { session, run } = await turnInFlight(h.execution, store);
    h.transports[0]!.transport.crash();
    await until(() => store.getRun(run.runId)!.status, status => status === "unknown");
    broken.close();
    const spawned = h.transports.length;
    const result = await h.execution.reconcile(store.getRun(run.runId)!, session);
    expect(result.outcome).toEqual({ result: "unconfirmed", reasonCode: "orphan_check_unavailable" });
    expect(result.run.status).toBe("unknown");
    expect(h.transports.length).toBe(spawned); // no new app-server
    expect(store.activeRunForProject("alpha")).toBeNull();
    expect(ledger.orphans()).toEqual([]); // non-strict readers (dashboard, reliability) keep working
    expect(() => ledger.orphans({ strict: true })).toThrow("process_ledger_unavailable");
  });
});

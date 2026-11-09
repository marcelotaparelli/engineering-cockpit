import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore, type RunRecord } from "../../src/runtime-store.ts";
import { ExecutionService, type ExecutionLog } from "../../src/execution.ts";
import { CodexAppServerAdapter } from "../../src/codex-adapter.ts";
import { FakeCodexTransport, FakeCodexWorld } from "../../src/fake-codex.ts";
import { EventHub } from "../../src/event-hub.ts";
import { ProcessLedger } from "../../src/process-ledger.ts";
import { LocalSecurity } from "../../src/local-security.ts";
import { startServer } from "../../src/server.ts";
import type { MsbChild, MsbSpawn } from "../../src/msb-transport.ts";
import type { Snapshot } from "../../src/model.ts";

/**
 * Shared world of the F2 orphan tests: real `sleep` processes stand in for the surviving `msb exec … codex app-server`
 * (PIDs, kernel start times and liveness come from the real /proc), the provider is the deterministic fake App Server whose
 * world outlives the Cockpit like the VM does, and a Cockpit is the real ExecutionService over a real RuntimeStore file.
 * Call `closeOrphanWorld` from `afterEach`.
 */
export const credential = "f".repeat(64);
export const CODEX_ARGV = (vm: string) => ["msb", "exec", "--stream", vm, "--", "codex", "app-server", "--listen", "stdio://"];
export const quiet = () => {};
/** In production the HMAC key of idempotency digests lives in `digest.key` and survives restarts; every test Cockpit shares one. */
const DIGEST_KEY = new Uint8Array(32).fill(7);
export const children: Bun.Subprocess[] = [];
export const cleanups: Array<() => Promise<void> | void> = [];
export async function closeOrphanWorld(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } await child.exited; }
}

/** Runs `sleep` whatever the msb argv says: a real, controllable stand-in for the surviving `msb exec … codex app-server`. */
export const sleepSpawn: MsbSpawn = () => {
  const child = Bun.spawn(["sleep", "60"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  children.push(child);
  return child as unknown as MsbChild;
};
export async function deadIdentity(): Promise<{ pid: number; startTicks: string }> {
  const gone = Bun.spawn(["true"]);
  await gone.exited;
  return { pid: gone.pid, startTicks: "1" };
}
export async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timeout; last=${JSON.stringify(value)}`);
    await Bun.sleep(10);
  }
}

export const snapshot = (): Snapshot => ({ source: "mock", host_verification: "not_verified", observed_at: new Date().toISOString(), projects: ["alpha", "beta"],
  vms: [
    { vm_name: "codex-alpha", project: "alpha", provider: "codex", state: "running", orphaned: false },
    { vm_name: "codex-beta", project: "beta", provider: "codex", state: "running", orphaned: false },
  ] });

/** One "VM" world per VM name, shared by every Cockpit instance of a test (the provider state outlives the Cockpit). */
export function cockpit(store: RuntimeStore, worlds: Map<string, FakeCodexWorld>, processes?: ConstructorParameters<typeof ExecutionService>[0]["processes"]) {
  const transports: Array<{ vmName: string; transport: FakeCodexTransport }> = [];
  const logs: ExecutionLog[] = [];
  const adapter = new CodexAppServerAdapter(target => {
    let world = worlds.get(target.vmName);
    if (!world) { world = new FakeCodexWorld(); worlds.set(target.vmName, world); }
    const transport = new FakeCodexTransport(world, { delayMs: 2 });
    transports.push({ vmName: target.vmName, transport });
    return transport;
  });
  const execution = new ExecutionService({ store, adapter, hub: new EventHub(), refresh: async () => snapshot(), log: entry => { logs.push(entry); }, digestKey: DIGEST_KEY, ...(processes ? { processes } : {}) });
  cleanups.push(() => execution.close());
  return { execution, transports, logs };
}

export async function tempStore(): Promise<{ path: string; open: () => RuntimeStore }> {
  const dir = await mkdtemp(join(tmpdir(), "cockpit-f2-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "runtime", "runtime.sqlite");
  return { path, open: () => { const store = new RuntimeStore(path); cleanups.push(() => store.close()); return store; } };
}

/** A Codex turn still in progress on the VM: the fake App Server keeps an "elicit" turn open until it is interrupted. */
export async function turnInFlight(execution: ExecutionService, store: RuntimeStore, vmName = "codex-alpha", project = "alpha") {
  const target = await execution.revalidate(vmName, project);
  const session = await execution.openSession(target, "new");
  const prompt = "elicit: tarefa longa que segue rodando na VM";
  const key = `key-${crypto.randomUUID()}`;
  const { run } = await execution.startRun(session, prompt, key);
  const bound = await until(() => store.getRun(run.runId)!, value => value.status === "running" && value.providerRunId !== null);
  return { session, run: bound, key, prompt };
}
export const turnStatus = (world: FakeCodexWorld, run: RunRecord) =>
  [...world.threads.values()].flatMap(thread => thread.turns).find(turn => turn.id === run.providerRunId)?.status;


/**
 * The scenario every F2 orphan test starts from: Cockpit #1 runs a Codex turn (still in progress on the "VM") and is killed
 * without closing anything, its `msb exec … codex app-server` child (a real `sleep`) survives under a dead owner, and Cockpit #2
 * opens the same database and classifies it. Nothing in the world is signalled by the setup after the child is created.
 */
export async function crashWithOrphan() {
  const worlds = new Map<string, FakeCodexWorld>();
  const db = await tempStore();
  const first = db.open();
  const before = cockpit(first, worlds);
  const started = await turnInFlight(before.execution, first);
  const crashed = new ProcessLedger(first, { self: await deadIdentity(), log: quiet });
  const orphan = crashed.track(sleepSpawn)(CODEX_ARGV("codex-alpha"), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} }) as unknown as Bun.Subprocess;
  before.transports[0]!.transport.crash();
  await until(() => first.getRun(started.run.runId)!.status, status => status === "unknown");
  const world = worlds.get("codex-alpha")!;
  const store = db.open();
  const ledger = new ProcessLedger(store, { log: quiet });
  const recovered = ledger.recover();
  const after = cockpit(store, worlds, ledger);
  return { worlds, world, db, store, ledger, recovered, after, orphan, key: started.key, prompt: started.prompt,
    session: store.getSession(started.session.sessionId)!, run: store.getRun(started.run.runId)!, turnsBefore: world.turnStarts };
}

/** The real HTTP server over a Cockpit, with a logged-in client (cookie, proof, CSRF and nonce as the browser sends them). */
export async function serve(store: RuntimeStore, execution: ExecutionService, grants: string[], refresh: () => Promise<Snapshot> = async () => snapshot()) {
  const server = startServer({ source: "mock", port: 0, security: new LocalSecurity(credential, grants), runtime: store, execution, hub: new EventHub(),
    discovery: { refresh }, log: quiet });
  cleanups.push(() => { server.stop(true); });
  const base = server.url.toString();
  const origin = base.slice(0, -1);
  const login = await fetch(base + "api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ credential }) });
  const auth = await login.json() as { proof: string; csrf: string };
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  return {
    get: (path: string) => fetch(base + path, { headers: { Cookie: cookie, "X-Session-Proof": auth.proof } }),
    post: (path: string, body: unknown = {}, extra: Record<string, string> = {}) => fetch(base + path, { method: "POST", body: JSON.stringify(body), headers: { Cookie: cookie, "X-Session-Proof": auth.proof,
      "X-CSRF-Token": auth.csrf, "X-Request-Nonce": crypto.randomUUID().replaceAll("-", "") + "xx", Origin: origin, "Content-Type": "application/json", ...extra } }),
  };
}

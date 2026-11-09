import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { LocalSecurity } from "../src/local-security.ts";
import { RuntimeStore } from "../src/runtime-store.ts";
import { EventHub } from "../src/event-hub.ts";
import { ExecutionService } from "../src/execution.ts";
import { CodexAppServerAdapter } from "../src/codex-adapter.ts";
import { FakeCodexTransport, FakeCodexWorld } from "../src/fake-codex.ts";
import { GrantStore } from "../src/grant-store.ts";
import { ProjectGrants, reservedProjects } from "../src/project-grants.ts";
import { SafeError, type Snapshot } from "../src/model.ts";

/**
 * Independent verification round 3 (all three reproduced before the fix, mock providers only):
 *  1. turn/start reached the provider but its reply timed out → run `unknown`, turn live, revoke accepted and the work HIDDEN;
 *  2. a revoke landing while a reconcile waited → the reconcile revived the run (`running`) in the revoked project;
 *  3. an approval decision really lost → run `unknown` but still followed: not interruptible, not reconcilable, not revocable.
 * Rule now: proven live work (followed turn, open approval, operation in flight) refuses revocation; uncertain work does not
 * block it (no project stuck until a restart) but stays VISIBLE in "Precisa de você" and is restored by authorizing again.
 */
async function harness(transport: (world: FakeCodexWorld) => FakeCodexTransport) {
  const dir = await mkdtemp(join(tmpdir(), "cockpit-grant-live-"));
  const runtime = new RuntimeStore(join(dir, "rt", "runtime.sqlite"));
  const hub = new EventHub();
  const world = new FakeCodexWorld();
  const transports: FakeCodexTransport[] = [];
  const snapshot = (): Snapshot => ({ source: "mock", host_verification: "not_verified", observed_at: new Date().toISOString(), projects: ["alpha"],
    vms: [{ vm_name: "codex-alpha", project: "alpha", provider: "codex", state: "running", orphaned: false }] });
  const gate: { wait: Promise<void> | null; reached: () => void } = { wait: null, reached: () => {} };
  const execution = new ExecutionService({ store: runtime, hub, log: () => {}, refresh: async () => { if (gate.wait) { gate.reached(); await gate.wait; } return snapshot(); },
    adapter: new CodexAppServerAdapter(() => { const t = transport(world); transports.push(t); return t; }) });
  const store = new GrantStore(join(dir, "grants.sqlite"));
  const grants = ProjectGrants.managed({ config: [], reserved: reservedProjects(undefined), store });
  const credential = "e".repeat(64);
  const server = startServer({ source: "mock", port: 0, security: new LocalSecurity(credential, grants), runtime, execution, hub,
    discovery: { refresh: async () => snapshot() }, log: () => {}, audit: () => {} });
  const base = server.url.toString();
  const origin = base.slice(0, -1);
  const login = await fetch(base + "api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ credential }) });
  const auth = { cookie: login.headers.get("set-cookie")!.split(";")[0]!, ...(await login.json() as { csrf: string; proof: string }) };
  const headers = (extra: Record<string, string> = {}) => ({ Cookie: auth.cookie, "X-Session-Proof": auth.proof, "X-CSRF-Token": auth.csrf,
    "X-Request-Nonce": crypto.randomUUID().replaceAll("-", "") + "xx", Origin: origin, "Content-Type": "application/json", ...extra });
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(base + path, { method: "POST", body: JSON.stringify(body), headers: headers(extra) });
  const get = (path: string) => fetch(base + path, { headers: headers() });
  const outside = async () => ((await (await get("api/dashboard")).json()) as { attention: Array<Record<string, unknown>> }).attention.filter(item => item.kind === "run_outside_access");
  expect((await post("api/projects/alpha/grant", { confirm: "alpha" })).status).toBe(200);
  const sessionId = (await (await post("api/sessions", { vm_name: "codex-alpha", mode: "new" })).json() as { session_id: string }).session_id;
  const close = async () => { server.stop(true); await execution.close().catch(() => {}); runtime.close(); store.close(); await rm(dir, { recursive: true, force: true }); };
  return { runtime, world, transports, execution, grants, gate, post, get, outside, sessionId, close };
}
const waitFor = async (condition: () => boolean, ms = 3000) => { for (const end = Date.now() + ms; !condition() && Date.now() < end;) await Bun.sleep(10); return condition(); };

class LateTurnStart extends FakeCodexTransport {
  override async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "turn/start") { void super.request(method, params); throw new SafeError("rpc_deadline_exceeded"); }
    return super.request(method, params);
  }
}
class LostDecision extends FakeCodexTransport {
  override async respond(): Promise<void> { throw new Error("write timeout"); } // the decision never reaches the provider
}

test("1. ambiguous turn start (run `unknown`, turn live): revocation is effective but the run is never hidden; authorizing again restores it", async () => {
  const h = await harness(world => new LateTurnStart(world, { delayMs: 3 }));
  try {
    const run = await (await h.post(`api/sessions/${h.sessionId}/runs`, { prompt: "tarefa lenta" }, { "Idempotency-Key": "k-live-a-0001-abcdefgh" })).json() as { run_id: string };
    expect(await waitFor(() => h.runtime.getRun(run.run_id)!.status === "unknown")).toBe(true);
    expect([...h.world.threads.values()].flatMap(thread => thread.turns).some(turn => turn.status === "inProgress")).toBe(true);
    expect(await h.outside()).toEqual([]);
    expect((await h.post("api/projects/alpha/revoke", { confirm: "alpha" })).status).toBe(200); // uncertain work does not block
    expect((await h.get(`api/runs/${run.run_id}`)).status).toBe(404);
    expect(await h.outside()).toEqual([expect.objectContaining({ project: "alpha", vm_name: "codex-alpha", runs: 1, reserved: false })]);
    const item = (await h.outside())[0]!;
    expect(JSON.stringify(item)).not.toContain(run.run_id); // content-free: no ids, no prompt
    expect(JSON.stringify(item)).not.toContain("tarefa lenta");
    expect((await h.post("api/projects/alpha/grant", { confirm: "alpha" })).status).toBe(200);
    expect((await h.get(`api/runs/${run.run_id}`)).status).toBe(200);
    expect(await h.outside()).toEqual([]);
  } finally { await h.close(); }
});

test("2. a revoke can no longer land during a reconcile; the in-tick re-check stops a reconcile whose authorization is lost", async () => {
  const h = await harness(world => new FakeCodexTransport(world, { delayMs: 3 }));
  try {
    const run = await (await h.post(`api/sessions/${h.sessionId}/runs`, { prompt: "tarefa lenta" }, { "Idempotency-Key": "k-live-b-0001-abcdefgh" })).json() as { run_id: string };
    expect(await waitFor(() => h.runtime.getRun(run.run_id)!.providerRunId !== null)).toBe(true);
    h.transports[0]!.crash();
    expect(await waitFor(() => h.runtime.getRun(run.run_id)!.status === "unknown")).toBe(true);
    const reached = new Promise<void>(resolve => { h.gate.reached = resolve; });
    let open = () => {};
    h.gate.wait = new Promise<void>(resolve => { open = resolve; });
    const reconcile = h.post(`api/runs/${run.run_id}/reconcile`, {});
    await reached;
    const revoke = await h.post("api/projects/alpha/revoke", { confirm: "alpha" });
    expect(revoke.status).toBe(409);
    expect(((await revoke.json()) as { error: { code: string } }).error.code).toBe("project_busy");
    h.gate.wait = null; open();
    expect((await reconcile).status).toBe(200);
    expect(h.grants.source("alpha")).toBe("ui");
    expect((await h.get(`api/runs/${run.run_id}`)).status).toBe(200); // whatever the outcome, the operator still sees the run
  } finally { await h.close(); }
});

test("2b. service level: a reconcile whose authorization is gone when the provider answers changes nothing (no revival)", async () => {
  const h = await harness(world => new FakeCodexTransport(world, { delayMs: 3 }));
  try {
    const run = await (await h.post(`api/sessions/${h.sessionId}/runs`, { prompt: "tarefa lenta" }, { "Idempotency-Key": "k-live-d-0001-abcdefgh" })).json() as { run_id: string };
    expect(await waitFor(() => h.runtime.getRun(run.run_id)!.providerRunId !== null)).toBe(true);
    h.transports[0]!.crash();
    expect(await waitFor(() => h.runtime.getRun(run.run_id)!.status === "unknown")).toBe(true);
    const before = h.runtime.getRun(run.run_id)!;
    await expect(h.execution.reconcile(before, h.runtime.getSession(h.sessionId)!, () => false)).rejects.toThrow("resource_not_found");
    expect(h.runtime.getRun(run.run_id)!.status).toBe("unknown");
    expect(h.runtime.getRun(run.run_id)!.lifecycleVersion).toBe(before.lifecycleVersion);
    expect(h.execution.projectBusy("alpha")).toBe(false); // nothing re-added to the followed turns
  } finally { await h.close(); }
});

test("3. a lost approval decision no longer leaves the project stuck: the followed `unknown` run can be interrupted, then revoked", async () => {
  const h = await harness(world => new LostDecision(world, { delayMs: 3 }));
  try {
    const run = await (await h.post(`api/sessions/${h.sessionId}/runs`, { prompt: "pede approval" }, { "Idempotency-Key": "k-live-c-0001-abcdefgh" })).json() as { run_id: string };
    let approvals: Array<{ approvalId: string; version: number }> = [];
    for (let i = 0; i < 100 && approvals.length === 0; i++) { await Bun.sleep(20); approvals = ((await (await h.get("api/approvals")).json()) as { approvals: typeof approvals }).approvals; }
    await h.post(`api/approvals/${approvals[0]!.approvalId}/decision`, { decision: "approve", expected_version: approvals[0]!.version });
    expect(h.runtime.getRun(run.run_id)!.status).toBe("unknown");
    expect((await h.post("api/projects/alpha/revoke", { confirm: "alpha" })).status).toBe(409); // still followed: busy
    const interrupted = await h.post(`api/runs/${run.run_id}/interrupt`, {});
    expect(interrupted.status).toBe(202); // was 409 run_not_interruptible: stuck until a restart
    expect(await waitFor(() => !h.execution.projectBusy("alpha"))).toBe(true);
    expect((await h.post("api/projects/alpha/revoke", { confirm: "alpha" })).status).toBe(200);
  } finally { await h.close(); }
});

test("visibility outside access: only runs that may really still run are reported; processes of revoked projects are never hidden", async () => {
  const { buildDashboard } = await import("../src/dashboard.ts");
  const dir = await mkdtemp(join(tmpdir(), "cockpit-outside-"));
  const runtime = new RuntimeStore(join(dir, "rt", "runtime.sqlite"));
  try {
    const at = (s: number) => new Date(Date.UTC(2026, 10, 9, 12, 0, s)).toISOString();
    const session = (id: string) => runtime.createSession({ sessionId: id, target: { provider: "codex", projectId: "zeta", vmName: "codex-zeta", vmInstanceId: null, discoveryVersion: "v" },
      providerSessionId: `t-${id}`, createdAt: at(0), lastObservedAt: at(0) });
    const run = (sessionId: string, id: string, s: number, end: "unknown" | "completed", reason = "transport_lost") => {
      const r = runtime.beginRun({ runId: id, sessionId, idempotencyKey: `key-${id}-000000000`, requestDigest: "a".repeat(64), createdAt: at(s) }).run;
      runtime.transition(r.runId, 1, "dispatching", at(s));
      if (end === "unknown") runtime.transition(r.runId, 2, "unknown", at(s), { reasonCode: reason });
      else { runtime.transition(r.runId, 2, "running", at(s)); runtime.transition(r.runId, 3, "completed", at(s)); }
    };
    session("s-old"); run("s-old", "r-old-unknown", 1, "unknown"); run("s-old", "r-new-done", 2, "completed"); // superseded
    session("s-stop"); run("s-stop", "r-vm-stopped", 3, "unknown", "vm_stopped");                         // VM verified stopped
    session("s-live"); run("s-live", "r-maybe-live", 4, "unknown");                                          // may still run
    const security = new LocalSecurity("a".repeat(64), ["alpha"]);
    const login = security.login("a".repeat(64));
    const principal = security.authenticate(`cockpit_session=${login.cookie}`, login.proof);
    const execution = { orphanProcesses: () => [{ pid: 777, kind: "codex_app_server", vmName: "codex-zeta", providerSessionId: "t-s-live", since: at(5), detectedAt: at(6) }],
      approvalView: () => null, blockedRequests: () => [], supports: () => true, unsupportedReason: () => null, capabilities: () => null, reliability: () => null } as never;
    const view = buildDashboard({ store: runtime, execution, principal, security, snapshot: null, discoveryError: null, source: "mock" }) as { attention: Array<Record<string, unknown>> };
    const outside = view.attention.filter(item => item.kind === "run_outside_access");
    expect(outside).toEqual([expect.objectContaining({ project: "zeta", vm_name: "codex-zeta", runs: 1, reserved: false })]);
    expect(view.attention).toContainEqual(expect.objectContaining({ kind: "orphan_process", pid: 777, project: "zeta", outside_access: true, session_id: null }));
  } finally { runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

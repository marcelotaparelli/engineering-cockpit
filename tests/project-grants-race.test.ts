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
import type { Snapshot } from "../src/model.ts";

/**
 * Independent security review, finding 2 (reproduced before the fix): a revoke landing while `startRun` waited on the VM
 * revalidation still created and dispatched a run the operator could then no longer see, interrupt or approve.
 */
test("revoke vs an operation in flight: refused while it is held (HTTP); the in-tick re-check stops any effect if authorization is lost (service)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cockpit-grant-race-"));
  const runtime = new RuntimeStore(join(dir, "rt", "runtime.sqlite"));
  const hub = new EventHub();
  const world = new FakeCodexWorld();
  const adapter = new CodexAppServerAdapter(() => new FakeCodexTransport(world, { delayMs: 3 }));
  const snapshot = (): Snapshot => ({ source: "mock", host_verification: "not_verified", observed_at: new Date().toISOString(), projects: ["alpha"],
    vms: [{ vm_name: "codex-alpha", project: "alpha", provider: "codex", state: "running", orphaned: false }] });
  let gate: Promise<void> | null = null;
  let release = () => {};
  const execution = new ExecutionService({ store: runtime, adapter, hub, log: () => {}, refresh: async () => { if (gate) await gate; return snapshot(); } });
  const store = new GrantStore(join(dir, "grants.sqlite"));
  const grants = ProjectGrants.managed({ config: [], reserved: reservedProjects(undefined), store });
  const credential = "e".repeat(64);
  const server = startServer({ source: "mock", port: 0, security: new LocalSecurity(credential, grants), runtime, execution, hub,
    discovery: { refresh: async () => snapshot() }, log: () => {}, audit: () => {} });
  const base = server.url.toString();
  const origin = base.slice(0, -1);
  try {
    const login = await fetch(base + "api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ credential }) });
    const auth = { cookie: login.headers.get("set-cookie")!.split(";")[0]!, ...(await login.json() as { csrf: string; proof: string }) };
    const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(base + path, { method: "POST", body: JSON.stringify(body), headers: { Cookie: auth.cookie,
      "X-Session-Proof": auth.proof, "X-CSRF-Token": auth.csrf, "X-Request-Nonce": crypto.randomUUID().replaceAll("-", "") + "xx", Origin: origin, "Content-Type": "application/json", ...extra } });
    expect((await post("api/projects/alpha/grant", { confirm: "alpha" })).status).toBe(200);
    const opened = await post("api/sessions", { vm_name: "codex-alpha", mode: "new" });
    expect(opened.status).toBe(201);
    const sessionId = (await opened.json() as { session_id: string }).session_id;

    // Layer 1 (HTTP hold, review round 3): a revoke can no longer land while an authorized send is waiting — it is refused, and
    // the send completes normally in a project that is still authorized. Nothing invisible is ever created.
    gate = new Promise(resolve => { release = resolve; });
    const pending = post(`api/sessions/${sessionId}/runs`, { prompt: "hello" }, { "Idempotency-Key": "k-race-0001-abcdefghij" });
    await Bun.sleep(50);
    const busy = await post("api/projects/alpha/revoke", { confirm: "alpha" });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe("project_busy");
    gate = null; release();
    expect((await pending).status).toBe(202);
    expect(grants.source("alpha")).toBe("ui");
    for (let i = 0; i < 200 && execution.projectBusy("alpha"); i++) await Bun.sleep(10);

    gate = new Promise(resolve => { release = resolve; });
    const opening = post("api/sessions", { vm_name: "codex-alpha", mode: "new" }); // waits in the server's revalidate
    await Bun.sleep(50);
    expect((await post("api/projects/alpha/revoke", { confirm: "alpha" })).status).toBe(409);
    gate = null; release();
    expect((await opening).status).toBe(201);

    // Layer 2 (in-tick re-check inside the execution service, first review): whatever the caller, an authorization lost during
    // the wait stops the effect — no run, no session.
    const runsBefore = runtime.listRuns(sessionId, 50).length;
    const session = runtime.getSession(sessionId)!;
    let allowed = true;
    gate = new Promise(resolve => { release = resolve; });
    const direct = execution.startRun(session, "hello again", "k-race-0002-abcdefghij", () => allowed);
    await Bun.sleep(30);
    allowed = false;
    gate = null; release();
    await expect(direct).rejects.toThrow("resource_not_found");
    expect(runtime.listRuns(sessionId, 50)).toHaveLength(runsBefore);
    const sessionsBefore = runtime.listSessions(["alpha"]).length;
    const target = await execution.revalidate("codex-alpha", "alpha");
    await expect(execution.openSession(target, "new", undefined, () => false)).rejects.toThrow("resource_not_found");
    expect(runtime.listSessions(["alpha"]).length).toBe(sessionsBefore);
  } finally {
    server.stop(true); await execution.close().catch(() => {}); runtime.close(); store.close(); await rm(dir, { recursive: true, force: true });
  }
});

class AmbiguousDecisionTransport extends FakeCodexTransport {
  // The decision DOES reach the provider (later) but the write reports failure → run `unknown` while the turn is still live.
  override async respond(id: Parameters<FakeCodexTransport["respond"]>[0], result: unknown): Promise<void> {
    setTimeout(() => { void super.respond(id, result); }, 300);
    throw new Error("write timeout");
  }
}

/**
 * Independent security review round 2, finding F1 (reproduced before the fix): with the run `unknown` after
 * `approval_delivery_unconfirmed`, revoke was accepted while the provider turn was still live, hiding work the operator could
 * still interrupt or decide. Revoke must refuse while this process still follows a turn or holds an approval of the project.
 */
test("revoke is refused while a provider turn is still live, even when the run reads `unknown`; allowed once it ends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cockpit-grant-live-"));
  const runtime = new RuntimeStore(join(dir, "rt", "runtime.sqlite"));
  const hub = new EventHub();
  const world = new FakeCodexWorld();
  const snapshot = (): Snapshot => ({ source: "mock", host_verification: "not_verified", observed_at: new Date().toISOString(), projects: ["alpha"],
    vms: [{ vm_name: "codex-alpha", project: "alpha", provider: "codex", state: "running", orphaned: false }] });
  const execution = new ExecutionService({ store: runtime, hub, log: () => {}, refresh: async () => snapshot(),
    adapter: new CodexAppServerAdapter(() => new AmbiguousDecisionTransport(world, { delayMs: 3 })) });
  const store = new GrantStore(join(dir, "grants.sqlite"));
  const grants = ProjectGrants.managed({ config: [], reserved: reservedProjects(undefined), store });
  const credential = "e".repeat(64);
  const server = startServer({ source: "mock", port: 0, security: new LocalSecurity(credential, grants), runtime, execution, hub,
    discovery: { refresh: async () => snapshot() }, log: () => {}, audit: () => {} });
  const base = server.url.toString();
  const origin = base.slice(0, -1);
  try {
    const login = await fetch(base + "api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ credential }) });
    const auth = { cookie: login.headers.get("set-cookie")!.split(";")[0]!, ...(await login.json() as { csrf: string; proof: string }) };
    const headers = (extra: Record<string, string> = {}) => ({ Cookie: auth.cookie, "X-Session-Proof": auth.proof, "X-CSRF-Token": auth.csrf,
      "X-Request-Nonce": crypto.randomUUID().replaceAll("-", "") + "xx", Origin: origin, "Content-Type": "application/json", ...extra });
    const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(base + path, { method: "POST", body: JSON.stringify(body), headers: headers(extra) });
    expect((await post("api/projects/alpha/grant", { confirm: "alpha" })).status).toBe(200);
    const sessionId = (await (await post("api/sessions", { vm_name: "codex-alpha", mode: "new" })).json() as { session_id: string }).session_id;
    const run = await (await post(`api/sessions/${sessionId}/runs`, { prompt: "pede approval" }, { "Idempotency-Key": "k-live-0001-abcdefghij" })).json() as { run_id: string };
    let approvals: Array<{ approvalId: string; version: number }> = [];
    for (let i = 0; i < 100 && approvals.length === 0; i++) { await Bun.sleep(20); approvals = (await (await fetch(base + "api/approvals", { headers: headers() })).json() as { approvals: typeof approvals }).approvals; }
    expect(approvals).toHaveLength(1);
    await post(`api/approvals/${approvals[0]!.approvalId}/decision`, { decision: "approve", expected_version: approvals[0]!.version });
    expect(runtime.getRun(run.run_id)!.status).toBe("unknown");
    expect(execution.projectBusy("alpha")).toBe(true);
    const refused = await post("api/projects/alpha/revoke", { confirm: "alpha" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("project_busy");
    expect(grants.source("alpha")).toBe("ui");
    for (let i = 0; i < 200 && execution.projectBusy("alpha"); i++) await Bun.sleep(10); // the turn ends on its own
    expect(execution.projectBusy("alpha")).toBe(false);
    expect((await post("api/projects/alpha/revoke", { confirm: "alpha" })).status).toBe(200);
  } finally {
    server.stop(true); await execution.close().catch(() => {}); runtime.close(); store.close(); await rm(dir, { recursive: true, force: true });
  }
});

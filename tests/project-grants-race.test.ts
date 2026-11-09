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
test("a revoke during startRun's wait creates no run; a revoke during openSession's wait creates no session", async () => {
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

    gate = new Promise(resolve => { release = resolve; });
    const pending = post(`api/sessions/${sessionId}/runs`, { prompt: "hello" }, { "Idempotency-Key": "k-race-0001-abcdefghij" });
    await Bun.sleep(50);
    expect((await post("api/projects/alpha/revoke", { confirm: "alpha" })).status).toBe(200); // nothing active yet
    gate = null; release();
    const refused = await pending;
    expect(refused.status).toBe(404);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("resource_not_found");
    expect(runtime.listRuns(sessionId, 10)).toEqual([]);

    expect((await post("api/projects/alpha/grant", { confirm: "alpha" })).status).toBe(200);
    const sessionsBefore = runtime.listSessions(["alpha"]).length;
    gate = new Promise(resolve => { release = resolve; });
    const opening = post("api/sessions", { vm_name: "codex-alpha", mode: "new" }); // waits in the server's revalidate
    await Bun.sleep(50);
    expect((await post("api/projects/alpha/revoke", { confirm: "alpha" })).status).toBe(200);
    gate = null; release();
    expect((await opening).status).toBe(404);
    expect(runtime.listSessions(["alpha"]).length).toBe(sessionsBefore);
  } finally {
    server.stop(true); await execution.close().catch(() => {}); runtime.close(); store.close(); await rm(dir, { recursive: true, force: true });
  }
});

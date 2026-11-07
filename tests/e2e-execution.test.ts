import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RequestLog } from "../src/server.ts";
import { LocalSecurity } from "../src/local-security.ts";
import { RuntimeStore } from "../src/runtime-store.ts";
import { EventHub } from "../src/event-hub.ts";
import { ExecutionService, type ExecutionLog } from "../src/execution.ts";
import { CodexAppServerAdapter } from "../src/codex-adapter.ts";
import { FakeCodexTransport, FakeCodexWorld } from "../src/fake-codex.ts";
import type { Snapshot } from "../src/model.ts";

/**
 * End-to-end over real HTTP: LocalSecurity → server routes → ExecutionService → CodexAppServerAdapter → fake App Server.
 * Only the `msb exec` child is replaced (by an in-process JSONL-shaped fake). Nothing here spawns processes.
 */
const credential = "e".repeat(64);
const worlds = new Map<string, FakeCodexWorld>();
const transports: FakeCodexTransport[] = [];
const httpLogs: RequestLog[] = [];
const execLogs: ExecutionLog[] = [];
let vmState: "running" | "stopped" = "running";
const snapshot = (): Snapshot => ({ source: "mock", host_verification: "not_verified", observed_at: new Date().toISOString(),
  projects: ["alpha", "beta"], vms: [
    { vm_name: "codex-alpha", project: "alpha", provider: "codex", state: vmState, orphaned: false },
    { vm_name: "codex-beta", project: "beta", provider: "codex", state: "running", orphaned: false },
  ] });
let dir: string;
let runtime: RuntimeStore;
let execution: ExecutionService;
let server: Bun.Server<undefined>;
let base: string;
let origin: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cockpit-e2e-"));
  runtime = new RuntimeStore(join(dir, "runtime", "runtime.sqlite"));
  const hub = new EventHub();
  const adapter = new CodexAppServerAdapter(target => {
    let world = worlds.get(target.vmName);
    if (!world) { world = new FakeCodexWorld(); worlds.set(target.vmName, world); }
    const transport = new FakeCodexTransport(world, { delayMs: 3 });
    transports.push(transport);
    return transport;
  });
  execution = new ExecutionService({ store: runtime, adapter, hub, refresh: async () => snapshot(), log: entry => { execLogs.push(entry); } });
  // Operator grants only "alpha"; "beta" exists but must stay invisible.
  server = startServer({ source: "mock", port: 0, security: new LocalSecurity(credential, ["alpha"]), runtime, execution, hub,
    discovery: { refresh: async () => snapshot() }, log: entry => { httpLogs.push(entry); }, heartbeatMs: 50 });
  base = server.url.toString();
  origin = base.slice(0, -1);
});
afterAll(async () => {
  server.stop(true);
  await execution.close();
  runtime.close();
  await rm(dir, { recursive: true, force: true });
});

interface Auth { cookie: string; proof: string; csrf: string }
async function login(): Promise<Auth> {
  const response = await fetch(base + "api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ credential }) });
  const body = await response.json() as { proof: string; csrf: string };
  return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, proof: body.proof, csrf: body.csrf };
}
const nonce = () => crypto.randomUUID().replaceAll("-", "") + "xx";
function get(auth: Auth, path: string) {
  return fetch(base + path, { headers: { Cookie: auth.cookie, "X-Session-Proof": auth.proof } });
}
function post(auth: Auth, path: string, body: unknown, extra: Record<string, string> = {}) {
  return fetch(base + path, { method: "POST", body: JSON.stringify(body), headers: { Cookie: auth.cookie, "X-Session-Proof": auth.proof,
    "X-CSRF-Token": auth.csrf, "X-Request-Nonce": nonce(), Origin: origin, "Content-Type": "application/json", ...extra } });
}
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting; last=${JSON.stringify(value)}`);
    await Bun.sleep(10);
  }
}
const runStatus = (auth: Auth, runId: string) => async () => await (await get(auth, `api/runs/${runId}`)).json() as { status: string; provider_bound: boolean; reason_code: string | null; approvals: Array<{ approvalId: string; version: number }> };
async function openSession(auth: Auth, vm = "codex-alpha"): Promise<string> {
  const response = await post(auth, "api/sessions", { vm_name: vm, mode: "new" });
  expect(response.status).toBe(201);
  return (await response.json() as { session_id: string }).session_id;
}
async function startRun(auth: Auth, sessionId: string, prompt: string, key = `k-${crypto.randomUUID()}`) {
  return post(auth, `api/sessions/${sessionId}/runs`, { prompt }, { "Idempotency-Key": key });
}

/** Minimal SSE reader with headers (EventSource cannot send the session proof). */
async function openStream(auth: Auth, lastEventId?: number) {
  const controller = new AbortController();
  const response = await fetch(base + "api/events", { signal: controller.signal,
    headers: { Cookie: auth.cookie, "X-Session-Proof": auth.proof, ...(lastEventId === undefined ? {} : { "Last-Event-ID": String(lastEventId) }) } });
  const events: Array<{ event: string; id: string | null; data: Record<string, unknown> }> = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          let event = "message"; let id: string | null = null; let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("id: ")) id = line.slice(4);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (data) events.push({ event, id, data: JSON.parse(data) });
        }
      }
    } catch { /* aborted */ }
  })();
  return { response, events, close: () => controller.abort() };
}

describe("MVP vertical flow over HTTP", () => {
  test("select VM → open session → send prompt once → stream → completed → history", async () => {
    const auth = await login();
    const dashboard = await (await get(auth, "api/dashboard")).json() as { vms: Array<{ vm_name: string; state: string; runnable: boolean }> };
    expect(dashboard.vms.map(vm => vm.vm_name)).toEqual(["codex-alpha"]);
    expect(dashboard.vms[0]).toMatchObject({ runnable: true, state: "idle" });

    const sessionId = await openSession(auth);
    const stream = await openStream(auth);
    expect(stream.response.headers.get("content-type")).toContain("text/event-stream");
    const key = "idem-0123456789abcdef";
    const first = await startRun(auth, sessionId, "explique o projeto", key);
    expect(first.status).toBe(202);
    const run = await first.json() as { run_id: string; status: string };
    // Retry/refresh with the same key never creates a second turn.
    const replay = await startRun(auth, sessionId, "explique o projeto", key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ run_id: run.run_id, replayed: true });
    expect((await startRun(auth, sessionId, "outro prompt", key)).status).toBe(409);

    const done = await until(runStatus(auth, run.run_id), value => value.status === "completed");
    expect(done.provider_bound).toBe(true);
    expect(worlds.get("codex-alpha")!.turnStarts).toBe(1);
    await until(async () => stream.events, events => events.some(item => item.event === "journal" && item.data.payload && (item.data.payload as { to?: string }).to === "completed"));
    const deltas = stream.events.filter(item => item.event === "live" && item.data.kind === "delta");
    expect(deltas.length).toBeGreaterThan(3);
    expect(deltas.map(item => item.data.delta).join("")).toContain("Simulação do Codex");
    const journal = stream.events.filter(item => item.event === "journal");
    expect(journal.every(item => item.id !== null && item.data.project === "alpha")).toBe(true);
    // Durable journal never carries prompt or response content.
    expect(JSON.stringify(journal)).not.toContain("explique o projeto");
    stream.close();

    const history = await (await get(auth, `api/sessions/${sessionId}/history`)).json() as { items: Array<{ kind: string; text: string }> };
    expect(history.items.map(item => item.kind)).toEqual(["user_message", "agent_message"]);
    expect(history.items[0]!.text).toBe("explique o projeto");

    // Resume by cursor: replay from the first durable id returns the rest without gaps.
    const firstId = Number(journal[0]!.id);
    const resumed = await openStream(auth, firstId);
    await until(async () => resumed.events, events => events.filter(item => item.event === "journal").length >= journal.length - 1);
    expect(Number(resumed.events.find(item => item.event === "journal")!.id)).toBe(firstId + 1);
    resumed.close();

    const after = await (await get(auth, "api/dashboard")).json() as { vms: Array<{ state: string; next_step: string }> };
    expect(after.vms[0]!.state).toBe("completed");
  });

  test("approval inbox: exact request, CSRF, CAS replay no-op, conflict, then turn continues", async () => {
    const auth = await login();
    const sessionId = await openSession(auth);
    const run = await (await startRun(auth, sessionId, "rode os testes, precisa de aprovação")).json() as { run_id: string };
    await until(runStatus(auth, run.run_id), value => value.status === "awaiting_approval");
    const inbox = await (await get(auth, "api/approvals")).json() as { approvals: Array<{ approvalId: string; version: number; runId: string; summary: { command: string; actionType: string } }> };
    expect(inbox.approvals).toHaveLength(1);
    const approval = inbox.approvals[0]!;
    expect(approval).toMatchObject({ runId: run.run_id, version: 1, summary: { command: "bun test", actionType: "command" } });
    const dashboard = await (await get(auth, "api/dashboard")).json() as { attention: Array<{ kind: string }>; counts: { awaiting_approval: number } };
    expect(dashboard.attention.map(item => item.kind)).toContain("approval");

    const noCsrf = await fetch(base + `api/approvals/${approval.approvalId}/decision`, { method: "POST", body: JSON.stringify({ decision: "approve", expected_version: 1 }),
      headers: { Cookie: auth.cookie, "X-Session-Proof": auth.proof, Origin: origin, "Content-Type": "application/json", "X-Request-Nonce": nonce() } });
    expect(noCsrf.status).toBe(403);
    expect((await post(auth, `api/approvals/${approval.approvalId}/decision`, { decision: "approve", expected_version: 1, extra: true })).status).toBe(400);

    const decided = await post(auth, `api/approvals/${approval.approvalId}/decision`, { decision: "approve", expected_version: 1 });
    expect(decided.status).toBe(200);
    expect(await decided.json()).toMatchObject({ status: "approved", version: 2 });
    const again = await post(auth, `api/approvals/${approval.approvalId}/decision`, { decision: "approve", expected_version: 1 });
    expect(again.status).toBe(200);
    expect((await post(auth, `api/approvals/${approval.approvalId}/decision`, { decision: "reject", expected_version: 1 })).status).toBe(409);

    await until(runStatus(auth, run.run_id), value => value.status === "completed");
    const history = await (await get(auth, `api/sessions/${sessionId}/history`)).json() as { items: Array<{ kind: string; status: string | null; exitCode: number | null }> };
    expect(history.items.find(item => item.kind === "command")).toMatchObject({ status: "completed", exitCode: 0 });
    expect(runtime.getApproval(approval.approvalId)?.status).toBe("approved");
  });

  test("rejecting an approval declines only that request", async () => {
    const auth = await login();
    const sessionId = await openSession(auth);
    const run = await (await startRun(auth, sessionId, "approval please")).json() as { run_id: string };
    const waiting = await until(runStatus(auth, run.run_id), value => value.status === "awaiting_approval");
    const approval = waiting.approvals[0]!;
    expect((await post(auth, `api/approvals/${approval.approvalId}/decision`, { decision: "reject", expected_version: approval.version })).status).toBe(200);
    await until(runStatus(auth, run.run_id), value => value.status === "completed");
    const history = await (await get(auth, `api/sessions/${sessionId}/history`)).json() as { items: Array<{ kind: string; status: string | null }> };
    expect(history.items.find(item => item.kind === "command")?.status).toBe("declined");
  });

  test("interrupt ends as interrupted only after provider confirmation; one writer per project", async () => {
    const auth = await login();
    const sessionId = await openSession(auth);
    const run = await (await startRun(auth, sessionId, "resposta lenta por favor")).json() as { run_id: string };
    await until(runStatus(auth, run.run_id), value => value.status === "running" && value.provider_bound);
    // Second writer for the same project is refused while the first is active.
    const otherSession = await openSession(auth);
    const busy = await startRun(auth, otherSession, "paralelo");
    expect(busy.status).toBe(409);
    expect((await busy.json() as { error: { code: string } }).error.code).toBe("project_busy");

    const interrupt = await post(auth, `api/runs/${run.run_id}/interrupt`, {});
    expect(interrupt.status).toBe(202);
    const final = await until(runStatus(auth, run.run_id), value => value.status === "interrupted");
    expect(final.status).toBe("interrupted");
    // Interrupting a terminal run is an idempotent no-op.
    expect((await post(auth, `api/runs/${run.run_id}/interrupt`, {})).status).toBe(202);
  });

  test("failed turn is reported as failed with a safe reason", async () => {
    const auth = await login();
    const sessionId = await openSession(auth);
    const run = await (await startRun(auth, sessionId, "simule uma falha")).json() as { run_id: string };
    const final = await until(runStatus(auth, run.run_id), value => value.status === "failed");
    expect(final.reason_code).toBe("provider_turn_failed");
  });

  test("transport loss mid-turn becomes unknown, is never resent, and reconcile resolves it", async () => {
    const auth = await login();
    const sessionId = await openSession(auth);
    const before = worlds.get("codex-alpha")!.turnStarts;
    const run = await (await startRun(auth, sessionId, "lento: vai cair a conexão")).json() as { run_id: string };
    await until(runStatus(auth, run.run_id), value => value.status === "running" && value.provider_bound);
    transports.at(-1)!.crash();
    const lost = await until(runStatus(auth, run.run_id), value => value.status === "unknown");
    expect(lost.reason_code).toBe("transport_lost");
    expect(worlds.get("codex-alpha")!.turnStarts).toBe(before + 1);
    const dashboard = await (await get(auth, "api/dashboard")).json() as { attention: Array<{ kind: string; run_id: string }> };
    expect(dashboard.attention).toContainEqual(expect.objectContaining({ kind: "unknown_run", run_id: run.run_id }));
    // Let the simulated turn finish on the "VM", then reconcile reads its real state over a new connection.
    await Bun.sleep(1200);
    const reconciled = await post(auth, `api/runs/${run.run_id}/reconcile`, {});
    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toMatchObject({ status: "completed", reason_code: "reconciled" });
    expect(worlds.get("codex-alpha")!.turnStarts).toBe(before + 1);
  });

  test("VM revalidation at dispatch: a stopped VM yields zero turns", async () => {
    const auth = await login();
    const sessionId = await openSession(auth);
    const before = worlds.get("codex-alpha")!.turnStarts;
    vmState = "stopped";
    try {
      const response = await startRun(auth, sessionId, "não deve executar");
      expect(response.status).toBe(409);
      expect((await response.json() as { error: { code: string } }).error.code).toBe("target_unavailable");
    } finally { vmState = "running"; }
    expect(worlds.get("codex-alpha")!.turnStarts).toBe(before);
  });

  test("resources of ungranted projects are indistinguishable from missing ones", async () => {
    const auth = await login();
    const foreign = runtime.createSession({ sessionId: "ses-foreign", target: { provider: "codex", projectId: "beta", vmName: "codex-beta", vmInstanceId: null, discoveryVersion: "v" },
      providerSessionId: "thread-foreign", createdAt: new Date().toISOString(), lastObservedAt: new Date().toISOString() });
    for (const path of [`api/sessions/${foreign.sessionId}`, `api/sessions/${foreign.sessionId}/history`, "api/sessions/ses-absent"]) {
      const response = await get(auth, path);
      expect(response.status).toBe(404);
      expect((await response.json() as { error: { code: string } }).error.code).toBe("resource_not_found");
    }
    expect((await startRun(auth, foreign.sessionId, "x")).status).toBe(404);
    expect((await post(auth, "api/sessions", { vm_name: "codex-beta", mode: "new" })).status).toBe(404);
    expect((await get(auth, "api/vms/codex-beta/threads")).status).toBe(404);
    const stream = await openStream(auth, 0);
    await Bun.sleep(100);
    expect(stream.events.every(item => item.data.project === "alpha")).toBe(true);
    stream.close();
  });

  test("mutations require session, CSRF, idempotency key and exact bodies", async () => {
    const auth = await login();
    const sessionId = await openSession(auth);
    const noKey = await post(auth, `api/sessions/${sessionId}/runs`, { prompt: "x" });
    expect(noKey.status).toBe(400);
    expect((await startRun(auth, sessionId, "")).status).toBe(400);
    expect((await post(auth, `api/sessions/${sessionId}/runs`, { prompt: "x", cwd: "/" }, { "Idempotency-Key": "k".repeat(20) })).status).toBe(400);
    const anonymous = await fetch(base + `api/sessions/${sessionId}/runs`, { method: "POST", body: "{\"prompt\":\"x\"}", headers: { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": "k".repeat(20) } });
    expect(anonymous.status).toBe(401);
    expect((await post(auth, "api/sessions", { vm_name: "codex-alpha", mode: "resume", thread_id: "../../etc" })).status).toBe(400);
    expect((await post(auth, "api/exec", { cmd: "id" })).status).toBe(405);
    expect(JSON.stringify(httpLogs)).not.toMatch(/explique o projeto|bun test|Simulação/);
    expect(JSON.stringify(execLogs)).not.toMatch(/explique o projeto|bun test|Simulação|alpha/);
  });

  test("resume an existing provider thread binds to the same Cockpit session", async () => {
    const auth = await login();
    const sessionId = await openSession(auth);
    const session = runtime.getSession(sessionId)!;
    const threads = await (await get(auth, "api/vms/codex-alpha/threads")).json() as { threads: Array<{ id: string; sessionId: string | null }> };
    expect(threads.threads).toContainEqual(expect.objectContaining({ id: session.providerSessionId, sessionId }));
    const resumed = await post(auth, "api/sessions", { vm_name: "codex-alpha", mode: "resume", thread_id: session.providerSessionId });
    expect(resumed.status).toBe(201);
    expect((await resumed.json() as { session_id: string }).session_id).toBe(sessionId);
  });
});

describe("restart recovery", () => {
  test("in-flight runs become unknown and prepared runs fail without dispatch", async () => {
    const path = join(dir, "restart", "runtime.sqlite");
    const first = new RuntimeStore(path);
    const at = new Date().toISOString();
    first.createSession({ sessionId: "ses-r", target: { provider: "codex", projectId: "alpha", vmName: "codex-alpha", vmInstanceId: null, discoveryVersion: "v" }, providerSessionId: "thread-r", createdAt: at, lastObservedAt: at });
    const digest = "c".repeat(64);
    const running = first.beginRun({ runId: "run-r1", sessionId: "ses-r", idempotencyKey: "a".repeat(20), requestDigest: digest, createdAt: at }).run;
    first.transition(running.runId, 1, "dispatching", at);
    first.transition(running.runId, 2, "running", at, { providerRunId: "turn-r1" });
    first.createApproval({ approvalId: "apr-r1", runId: running.runId, actionType: "command", actionDigest: digest, createdAt: at, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    first.transition(running.runId, 3, "awaiting_approval", at);
    first.beginRun({ runId: "run-r2", sessionId: "ses-r", idempotencyKey: "b".repeat(20), requestDigest: digest, createdAt: at });
    first.close();

    const reopened = new RuntimeStore(path);
    expect(reopened.getRun("run-r1")).toMatchObject({ status: "unknown", reasonCode: "process_restarted" });
    expect(reopened.getApproval("apr-r1")).toMatchObject({ status: "expired", reasonCode: "process_restarted" });
    expect(reopened.getRun("run-r2")?.status).toBe("prepared");
    const service = new ExecutionService({ store: reopened, adapter: new CodexAppServerAdapter(() => { throw new Error("must not connect"); }), hub: new EventHub(),
      refresh: async () => snapshot(), log: () => {} });
    expect(reopened.getRun("run-r2")).toMatchObject({ status: "failed", reasonCode: "not_dispatched_before_restart" });
    await service.close();
    reopened.close();
  });
});

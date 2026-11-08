import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { LocalSecurity } from "../src/local-security.ts";
import { RuntimeStore } from "../src/runtime-store.ts";
import { EventHub } from "../src/event-hub.ts";
import { ExecutionService, type ExecutionLog } from "../src/execution.ts";
import { CodexAppServerAdapter } from "../src/codex-adapter.ts";
import { FakeCodexTransport, FakeCodexWorld } from "../src/fake-codex.ts";
import { ClaudeCodeAdapter } from "../src/claude-adapter.ts";
import { fakeClaudeSpawn, newFakeWorld, type FakeClaudeWorld } from "../src/fake-claude.ts";
import { SafeError, type Snapshot } from "../src/model.ts";
import type { ProviderAdapter } from "../src/provider.ts";

/**
 * E3 end-to-end over real HTTP: LocalSecurity → routes → ExecutionService (shared with Codex) → ClaudeCodeAdapter → fake CLI.
 * Only the `msb exec` child is replaced. Same sessions, runs, journal, approvals and SSE as Codex — no parallel platform.
 */
const credential = "c".repeat(64);
const claudeWorlds = new Map<string, FakeClaudeWorld>();
const execLogs: ExecutionLog[] = [];
const states: Record<string, "running" | "stopped"> = { "claude-alpha": "running", "codex-alpha": "running", "claude-beta": "running", "claude-engineering-cockpit": "running" };
const snapshot = (): Snapshot => ({ source: "mock", host_verification: "not_verified", observed_at: new Date().toISOString(),
  projects: ["alpha", "beta", "engineering-cockpit"], vms: Object.entries(states).map(([vm_name, state]) => ({ vm_name, state, orphaned: false,
    provider: vm_name.startsWith("claude-") ? "claude" as const : "codex" as const, project: vm_name.replace(/^(claude|codex)-/, "") })) });
const world = (vm: string) => { let value = claudeWorlds.get(vm); if (!value) { value = newFakeWorld(); claudeWorlds.set(vm, value); } return value; };
const streams = (vm = "claude-alpha") => world(vm).spawned.filter(item => item.argv.includes("stream-json"));
let dir: string;
let runtime: RuntimeStore;
let execution: ExecutionService;
let server: Bun.Server<undefined>;
let base: string;
let origin: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cockpit-e3-"));
  runtime = new RuntimeStore(join(dir, "runtime", "runtime.sqlite"));
  const hub = new EventHub();
  const codex = new CodexAppServerAdapter(() => new FakeCodexTransport(new FakeCodexWorld(), { delayMs: 3 }));
  const claude = new ClaudeCodeAdapter({ closeGraceMs: 100, idleMs: 60_000, spawn: (argv, options) => fakeClaudeSpawn(world(argv[3]!))(argv, options) });
  execution = new ExecutionService({ store: runtime, adapters: [codex, claude], hub, refresh: async () => snapshot(), log: entry => { execLogs.push(entry); } });
  server = startServer({ source: "mock", port: 0, security: new LocalSecurity(credential, ["alpha", "engineering-cockpit"]), runtime, execution, hub,
    discovery: { refresh: async () => snapshot() }, log: () => {}, heartbeatMs: 50 });
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
const get = (auth: Auth, path: string) => fetch(base + path, { headers: { Cookie: auth.cookie, "X-Session-Proof": auth.proof } });
const post = (auth: Auth, path: string, body: unknown, extra: Record<string, string> = {}) => fetch(base + path, { method: "POST", body: JSON.stringify(body),
  headers: { Cookie: auth.cookie, "X-Session-Proof": auth.proof, "X-CSRF-Token": auth.csrf, "X-Request-Nonce": nonce(), Origin: origin, "Content-Type": "application/json", ...extra } });
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting; last=${JSON.stringify(value)}`);
    await Bun.sleep(10);
  }
}
type RunBody = { run_id: string; status: string; reason_code: string | null; provider_bound: boolean; metrics: Record<string, unknown>;
  approvals: Array<{ approvalId: string; version: number; actionType: string; summary: Record<string, unknown> | null }> };
const readRun = (auth: Auth, runId: string) => async () => await (await get(auth, `api/runs/${runId}`)).json() as RunBody;
async function openSession(auth: Auth, vm = "claude-alpha"): Promise<string> {
  const response = await post(auth, "api/sessions", { vm_name: vm, mode: "new" });
  expect(response.status).toBe(201);
  const body = await response.json() as { session_id: string; provider: string; capabilities: Record<string, unknown> };
  expect(body).toMatchObject({ provider: "claude", capabilities: { questions: true, history: "cockpit", reconcile: "process" } });
  return body.session_id;
}
const startRun = (auth: Auth, sessionId: string, prompt: string, key = `k-${crypto.randomUUID()}`) => post(auth, `api/sessions/${sessionId}/runs`, { prompt }, { "Idempotency-Key": key });
const waitIdle = (auth: Auth, runId: string) => until(readRun(auth, runId), run => !["prepared", "dispatching", "running", "awaiting_approval"].includes(run.status));

describe("E3: Claude Code on the shared Cockpit infrastructure", () => {
  test("dashboard lists Claude next to Codex with capabilities; the reserved dev VM is never runnable; other projects stay hidden", async () => {
    const auth = await login();
    const dashboard = await (await get(auth, "api/dashboard")).json() as { vms: Array<{ vm_name: string; runnable: boolean; provider: string; capabilities: Record<string, unknown> | null }> };
    expect(dashboard.vms.map(vm => vm.vm_name)).toEqual(["claude-alpha", "claude-engineering-cockpit", "codex-alpha"]);
    expect(dashboard.vms.find(vm => vm.vm_name === "claude-alpha")).toMatchObject({ runnable: true, provider: "claude", capabilities: { sessionListing: "cockpit", usage: "run" } });
    expect(dashboard.vms.find(vm => vm.vm_name === "codex-alpha")).toMatchObject({ runnable: true, capabilities: { history: "paged" } });
    expect(dashboard.vms.find(vm => vm.vm_name === "claude-engineering-cockpit")!.runnable).toBe(false);
    const refused = await post(auth, "api/sessions", { vm_name: "claude-engineering-cockpit", mode: "new" });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: { code: string } }).error.code).toBe("target_unavailable");
    expect((await post(auth, "api/sessions", { vm_name: "claude-beta", mode: "new" })).status).toBe(404);
    expect(world("claude-engineering-cockpit").spawned).toHaveLength(0);
    expect(world("claude-beta").spawned).toHaveLength(0);
  });

  test("open → prompt exactly once (idempotent retry) → streamed → completed with per-run tokens → persisted history", async () => {
    const auth = await login();
    const sessionId = await openSession(auth);
    const key = "idem-claude-0123456789";
    const first = await startRun(auth, sessionId, "remember ABACATE", key);
    expect(first.status).toBe(202);
    const run = await first.json() as { run_id: string };
    const retry = await startRun(auth, sessionId, "remember ABACATE", key);
    expect(retry.status).toBe(200);
    expect((await retry.json() as { run_id: string; replayed: boolean })).toMatchObject({ run_id: run.run_id, replayed: true });
    const done = await waitIdle(auth, run.run_id);
    expect(done).toMatchObject({ status: "completed", provider_bound: true, metrics: { inputTokens: 10, outputTokens: 5, tokenScope: "run" } });
    expect(streams().flatMap(item => item.prompts)).toEqual(["remember ABACATE"]);
    const history = await (await get(auth, `api/sessions/${sessionId}/history`)).json() as { items: Array<{ kind: string; text: string }> };
    expect(history.items.map(item => item.kind)).toEqual(["user_message", "agent_message"]);
    const threads = await (await get(auth, "api/vms/claude-alpha/threads")).json() as { threads: unknown[] };
    expect(threads.threads).toEqual([]); // Claude cannot enumerate sessions: the Cockpit's own sessions are the list
  });

  test("tool approval through the shared inbox: approve sends the exact input once; a second decision conflicts", async () => {
    const auth = await login();
    const sessionId = await openSession(auth);
    const run = await (await startRun(auth, sessionId, "approve the probe")).json() as { run_id: string };
    const waiting = await until(readRun(auth, run.run_id), value => value.status === "awaiting_approval" && value.approvals.length === 1);
    const approval = waiting.approvals[0]!;
    expect(approval).toMatchObject({ actionType: "command", summary: { command: "touch /tmp/e2-approval-probe", toolName: "Bash" } });
    const inbox = await (await get(auth, "api/approvals")).json() as { approvals: Array<{ approvalId: string }> };
    expect(inbox.approvals.map(item => item.approvalId)).toContain(approval.approvalId);
    expect((await post(auth, `api/approvals/${approval.approvalId}/decision`, { decision: "approve", expected_version: approval.version, answers: { x: "y" } })).status).toBe(400);
    const decided = await post(auth, `api/approvals/${approval.approvalId}/decision`, { decision: "approve", expected_version: approval.version });
    expect(decided.status).toBe(200);
    expect((await post(auth, `api/approvals/${approval.approvalId}/decision`, { decision: "reject", expected_version: approval.version })).status).toBe(409);
    expect((await waitIdle(auth, run.run_id)).status).toBe("completed");
    const proc = streams().at(-1)!;
    expect(proc.allowedInputs).toEqual([{ command: "touch /tmp/e2-approval-probe", description: "probe" }]);
    expect(JSON.stringify(runtime.replay(0, 1000))).not.toContain("e2-approval-probe"); // content never reaches the journal
  });

  test("agent question answered through the same approval record; approve without answers is refused", async () => {
    const auth = await login();
    const sessionId = await openSession(auth);
    const run = await (await startRun(auth, sessionId, "ask me something")).json() as { run_id: string };
    const waiting = await until(readRun(auth, run.run_id), value => value.approvals.length === 1);
    const question = waiting.approvals[0]!;
    expect(question).toMatchObject({ actionType: "question", summary: { questions: [{ question: "A ou B?" }] } });
    expect((await post(auth, `api/approvals/${question.approvalId}/decision`, { decision: "approve", expected_version: question.version })).status).toBe(400);
    expect((await post(auth, `api/approvals/${question.approvalId}/decision`, { decision: "approve", expected_version: question.version, answers: { "A ou B?": "x".repeat(2001) } })).status).toBe(400);
    const answered = await post(auth, `api/approvals/${question.approvalId}/decision`, { decision: "approve", expected_version: question.version, answers: { "A ou B?": "A" } });
    expect(answered.status).toBe(200);
    expect((await waitIdle(auth, run.run_id)).status).toBe("completed");
    expect(streams().at(-1)!.allowedInputs[0]!.answers).toEqual({ "A ou B?": "A" });
    expect(runtime.getApproval(question.approvalId)).toMatchObject({ status: "approved", reasonCode: "human_answer" });
  });

  test("interrupt through the API ends the run as interrupted and the session keeps working", async () => {
    const auth = await login();
    const sessionId = await openSession(auth);
    const run = await (await startRun(auth, sessionId, "slow long essay")).json() as { run_id: string };
    await until(readRun(auth, run.run_id), value => value.status === "running" && value.provider_bound);
    expect((await post(auth, `api/runs/${run.run_id}/interrupt`, {})).status).toBe(202);
    expect((await waitIdle(auth, run.run_id)).status).toBe("interrupted");
    const next = await (await startRun(auth, sessionId, "oi")).json() as { run_id: string };
    expect((await waitIdle(auth, next.run_id)).status).toBe("completed");
  });

  test("usage limit is shown as a classified failure", async () => {
    const auth = await login();
    const sessionId = await openSession(auth);
    const run = await (await startRun(auth, sessionId, "quota")).json() as { run_id: string };
    expect(await waitIdle(auth, run.run_id)).toMatchObject({ status: "failed", reason_code: "provider_usage_limit" });
  });

  test("process death mid-turn → unknown, approvals expired, reconcile cannot confirm, same key never resends", async () => {
    const auth = await login();
    const sessionId = await openSession(auth);
    const key = "idem-crash-0123456789ab";
    const run = await (await startRun(auth, sessionId, "crash please", key)).json() as { run_id: string };
    const lost = await waitIdle(auth, run.run_id);
    expect(lost).toMatchObject({ status: "unknown", reason_code: "provider_session_lost" });
    const reconciled = await post(auth, `api/runs/${run.run_id}/reconcile`, {});
    expect(reconciled.status).toBe(200);
    expect((await reconciled.json() as { status: string }).status).toBe("unknown");
    const retry = await startRun(auth, sessionId, "crash please", key);
    expect((await retry.json() as { run_id: string; replayed: boolean })).toMatchObject({ run_id: run.run_id, replayed: true });
    expect(streams().flatMap(item => item.prompts).filter(prompt => prompt === "crash please")).toHaveLength(1);
    const dashboard = await (await get(auth, "api/dashboard")).json() as { attention: Array<{ kind: string; run_id: string }> };
    expect(dashboard.attention.some(item => item.kind === "unknown_run" && item.run_id === run.run_id)).toBe(true);
    // A fresh prompt after the loss resumes the session (it already had a turn) in a new process.
    const before = streams().length;
    const next = await (await startRun(auth, sessionId, "oi de novo")).json() as { run_id: string };
    expect((await waitIdle(auth, next.run_id)).status).toBe("completed");
    expect(streams().length).toBe(before + 1);
    expect(streams().at(-1)!.argv).toContain("--resume");
  });

  test("a stopped VM is revalidated before every operation: nothing is spawned or sent", async () => {
    const auth = await login();
    const sessionId = await openSession(auth);
    const before = streams().flatMap(item => item.prompts).length;
    states["claude-alpha"] = "stopped";
    try {
      const refused = await startRun(auth, sessionId, "não deve sair");
      expect(refused.status).toBe(409);
      expect((await refused.json() as { error: { code: string } }).error.code).toBe("target_unavailable");
    } finally { states["claude-alpha"] = "running"; }
    expect(streams().flatMap(item => item.prompts).length).toBe(before);
  });

  test("execution logs carry codes and ids only, never prompts or responses", () => {
    const text = JSON.stringify(execLogs);
    expect(text).not.toContain("ABACATE");
    expect(text).not.toContain("CANARIO");
    expect(execLogs.some(entry => entry.event === "provider.connected" && entry.outcome === "2.1.319")).toBe(true);
  });
});

describe("E3: boundary regressions", () => {
  test("answers that do not match the pending questions are refused before any state change", async () => {
    const auth = await login();
    const sessionId = await openSession(auth);
    const run = await (await startRun(auth, sessionId, "ask again")).json() as { run_id: string };
    const waiting = await until(readRun(auth, run.run_id), value => value.approvals.length === 1);
    const question = waiting.approvals[0]!;
    const wrong = await post(auth, `api/approvals/${question.approvalId}/decision`, { decision: "approve", expected_version: question.version, answers: { "outra pergunta?": "A" } });
    expect(wrong.status).toBe(400);
    expect(runtime.getApproval(question.approvalId)).toMatchObject({ status: "pending", version: question.version });
    expect((await readRun(auth, run.run_id)()).status).toBe("awaiting_approval");
    const proto = await post(auth, `api/approvals/${question.approvalId}/decision`, { decision: "approve", expected_version: question.version, answers: JSON.parse('{"__proto__": "x"}') });
    expect(proto.status).toBe(400);
    expect((await post(auth, `api/approvals/${question.approvalId}/decision`, { decision: "reject", expected_version: question.version })).status).toBe(200);
    expect((await waitIdle(auth, run.run_id)).status).toBe("completed");
    expect(streams().at(-1)!.decisions.at(-1)).toBe("deny");
  });
});

test("an adapter refusal raised before writing (session handle gone) fails the run instead of leaving it unknown", async () => {
  const localDir = await mkdtemp(join(tmpdir(), "cockpit-e3-notsent-"));
  const store = new RuntimeStore(join(localDir, "runtime", "runtime.sqlite"));
  const base = new ClaudeCodeAdapter({ closeGraceMs: 50, spawn: (argv, options) => fakeClaudeSpawn(world("claude-gamma"))(argv, options) });
  let refuse = false;
  // Same adapter, but startRun can refuse before writing (as when the session process vanished just before the prompt).
  const adapter: ProviderAdapter = { provider: "claude", capabilities: base.capabilities, acceptsTarget: vm => base.acceptsTarget(vm), probe: () => base.probe(),
    async connect(target) {
      const c = await base.connect(target);
      return { initialize: () => c.initialize(), listSessions: () => c.listSessions(), startSession: input => c.startSession(input),
        resumeSession: (ref, hints) => c.resumeSession(ref, hints), interrupt: ref => c.interrupt(ref), decideApproval: (ref, decision) => c.decideApproval(ref, decision),
        history: ref => c.history(ref), reconcile: ref => c.reconcile(ref), events: () => c.events(), close: () => c.close(),
        startRun: async input => { if (refuse) throw new SafeError("provider_session_not_loaded"); return c.startRun(input); } };
    } };
  const local = new ExecutionService({ store, adapters: [adapter], hub: new EventHub(), log: () => {},
    refresh: async () => ({ source: "mock", host_verification: "not_verified", observed_at: new Date().toISOString(), projects: ["gamma"],
      vms: [{ vm_name: "claude-gamma", provider: "claude", project: "gamma", state: "running", orphaned: false }] }) });
  try {
    const target = await local.revalidate("claude-gamma", "gamma");
    const session = await local.openSession(target, "new");
    refuse = true;
    const { run } = await local.startRun(session, "não sai", "key-notsent-0123456789");
    await until(async () => store.getRun(run.runId)!, value => value.status !== "prepared" && value.status !== "dispatching");
    expect(store.getRun(run.runId)).toMatchObject({ status: "failed", reasonCode: "provider_session_not_loaded" });
    expect(world("claude-gamma").spawned.flatMap(item => item.prompts)).toEqual([]);
  } finally { await local.close(); store.close(); await rm(localDir, { recursive: true, force: true }); }
});

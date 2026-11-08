import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { LocalSecurity } from "../src/local-security.ts";
import { RuntimeStore } from "../src/runtime-store.ts";
import { EventHub } from "../src/event-hub.ts";
import { ExecutionService } from "../src/execution.ts";
import { CodexAppServerAdapter } from "../src/codex-adapter.ts";
import { FakeCodexTransport, FakeCodexWorld } from "../src/fake-codex.ts";
import { ClaudeCodeAdapter } from "../src/claude-adapter.ts";
import { fakeClaudeSpawn, newFakeWorld, type FakeClaudeWorld } from "../src/fake-claude.ts";
import type { Snapshot } from "../src/model.ts";

/**
 * E3.1 — the conversation survives a complete Cockpit shutdown. Two independent Cockpit "processes" (server, ExecutionService,
 * adapters, RuntimeStore) run one after the other on the SAME SQLite file; only the fake Claude VM (its on-disk sessions and
 * memory) outlives them, as the real VM does. History is never rebuilt from Claude: after the restart it comes from SQLite.
 */
const credential = "d".repeat(64);
const states: Record<string, "running" | "stopped"> = { "claude-alpha": "running", "codex-alpha": "running" };
const snapshot = (): Snapshot => ({ source: "mock", host_verification: "not_verified", observed_at: new Date().toISOString(), projects: ["alpha"],
  vms: Object.entries(states).map(([vm_name, state]) => ({ vm_name, state, orphaned: false, provider: vm_name.startsWith("claude-") ? "claude" as const : "codex" as const, project: "alpha" })) });
const vmWorld: FakeClaudeWorld = newFakeWorld(); // the VM: survives Cockpit restarts
const SECRET = "sk-ant-api03-SEGREDOabcdefghijklmnop";

interface Cockpit { runtime: RuntimeStore; execution: ExecutionService; server: Bun.Server<undefined>; base: string; origin: string }
let dir: string;
let dbPath: string;
let cockpit: Cockpit;

function boot(): Cockpit {
  const runtime = new RuntimeStore(dbPath);
  const hub = new EventHub();
  const codex = new CodexAppServerAdapter(() => new FakeCodexTransport(new FakeCodexWorld(), { delayMs: 3 }));
  const claude = new ClaudeCodeAdapter({ closeGraceMs: 100, idleMs: 60_000, spawn: fakeClaudeSpawn(vmWorld) });
  const execution = new ExecutionService({ store: runtime, adapters: [codex, claude], hub, refresh: async () => snapshot(), log: () => {} });
  const server = startServer({ source: "mock", port: 0, security: new LocalSecurity(credential, ["alpha"]), runtime, execution, hub,
    discovery: { refresh: async () => snapshot() }, log: () => {}, heartbeatMs: 50 });
  const base = server.url.toString();
  return { runtime, execution, server, base, origin: base.slice(0, -1) };
}
/** Complete shutdown, in the order of the SIGTERM handler in index.ts. */
async function shutdown(c: Cockpit): Promise<void> {
  c.server.stop(true);
  await c.execution.close();
  c.runtime.close();
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cockpit-e31-"));
  dbPath = join(dir, "runtime", "runtime.sqlite");
  cockpit = boot();
});
afterAll(async () => {
  await shutdown(cockpit).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

interface Auth { cookie: string; proof: string; csrf: string }
async function login(): Promise<Auth> {
  const response = await fetch(cockpit.base + "api/auth/login", { method: "POST", headers: { Origin: cockpit.origin, "Content-Type": "application/json" }, body: JSON.stringify({ credential }) });
  const body = await response.json() as { proof: string; csrf: string };
  return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, proof: body.proof, csrf: body.csrf };
}
const nonce = () => crypto.randomUUID().replaceAll("-", "") + "xx";
const get = (auth: Auth, path: string) => fetch(cockpit.base + path, { headers: { Cookie: auth.cookie, "X-Session-Proof": auth.proof } });
const post = (auth: Auth, path: string, body: unknown, extra: Record<string, string> = {}) => fetch(cockpit.base + path, { method: "POST", body: JSON.stringify(body),
  headers: { Cookie: auth.cookie, "X-Session-Proof": auth.proof, "X-CSRF-Token": auth.csrf, "X-Request-Nonce": nonce(), Origin: cockpit.origin, "Content-Type": "application/json", ...extra } });
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting; last=${JSON.stringify(value)}`);
    await Bun.sleep(10);
  }
}
type RunBody = { run_id: string; status: string; reason_code: string | null; provider_bound: boolean; approvals: Array<{ approvalId: string; version: number; actionType: string }> };
type Item = { id: string; runId: string | null; kind: string; status: string | null; text: string | null; command: string | null; tool?: string;
  incomplete?: boolean; outputOmitted?: boolean; approval?: { status: string; actionType: string; questions: string[]; answers: Record<string, string> | null; command: string | null } };
type Page = { items: Item[]; next_cursor: string | null };
const readRun = (auth: Auth, runId: string) => async () => await (await get(auth, `api/runs/${runId}`)).json() as RunBody;
const startRun = async (auth: Auth, sessionId: string, prompt: string) =>
  await (await post(auth, `api/sessions/${sessionId}/runs`, { prompt }, { "Idempotency-Key": `k-${crypto.randomUUID()}` })).json() as { run_id: string };
const waitIdle = (auth: Auth, runId: string) => until(readRun(auth, runId), run => !["prepared", "dispatching", "running", "awaiting_approval"].includes(run.status));
const history = async (auth: Auth, sessionId: string, query = ""): Promise<Page> => await (await get(auth, `api/sessions/${sessionId}/history${query}`)).json() as Page;
/** Compact, content-level view of a conversation for order/duplication checks. */
const shape = (items: Item[]) => items.map(item => item.kind === "approval" ? `approval:${item.approval!.actionType}:${item.approval!.status}`
  : item.incomplete && item.kind === "agent_message" ? `agent_message:${(item.text ?? "").slice(0, 5)}…:incomplete` // length depends on timing
  : item.kind === "user_message" || item.kind === "agent_message" ? `${item.kind}:${(item.text ?? "").slice(0, 24)}`
  : `${item.kind}:${item.tool ?? ""}:${item.status}${item.incomplete ? ":incomplete" : ""}`);

describe("E3.1: persisted conversation across a complete Cockpit restart", () => {
  let sessionId: string;
  let before: Item[];
  let inFlight: string;

  test("multi-turn conversation with approval, question and interruption is recorded in order, sanitized, without duplicates", async () => {
    const auth = await login();
    const opened = await post(auth, "api/sessions", { vm_name: "claude-alpha", mode: "new" });
    expect(opened.status).toBe(201);
    sessionId = (await opened.json() as { session_id: string }).session_id;

    const first = await startRun(auth, sessionId, `remember SEGURANCA (minha chave: api_key=${SECRET})`);
    expect((await waitIdle(auth, first.run_id)).status).toBe("completed");

    const approve = await startRun(auth, sessionId, "approve this");
    const pendingTool = await until(readRun(auth, approve.run_id), run => run.approvals.length === 1);
    expect((await post(auth, `api/approvals/${pendingTool.approvals[0]!.approvalId}/decision`, { decision: "approve", expected_version: pendingTool.approvals[0]!.version })).status).toBe(200);
    expect((await waitIdle(auth, approve.run_id)).status).toBe("completed");

    const ask = await startRun(auth, sessionId, "ask me");
    const pendingQuestion = await until(readRun(auth, ask.run_id), run => run.approvals.length === 1);
    expect((await post(auth, `api/approvals/${pendingQuestion.approvals[0]!.approvalId}/decision`, { decision: "approve", expected_version: pendingQuestion.approvals[0]!.version, answers: { "A ou B?": "B" } })).status).toBe(200);
    expect((await waitIdle(auth, ask.run_id)).status).toBe("completed");

    // Interrupted while answering: the streamed part is kept and marked incomplete.
    const slow = await startRun(auth, sessionId, "slow essay");
    await until(() => history(auth, sessionId), page => page.items.some(item => item.runId === slow.run_id && item.kind === "agent_message"));
    await Bun.sleep(120); // more text streams; the 1 s write throttle keeps only the first chunk on disk until the run ends
    expect((await post(auth, `api/runs/${slow.run_id}/interrupt`, {})).status).toBe(202);
    expect((await waitIdle(auth, slow.run_id)).status).toBe("interrupted");

    const page = await history(auth, sessionId);
    expect(shape(page.items)).toEqual([
      "user_message:remember SEGURANCA (minh", "agent_message:OK",
      "user_message:approve this", "command:Bash:completed", "approval:command:approved", "agent_message:executado",
      "user_message:ask me", "tool:AskUserQuestion:completed", "approval:question:approved", "agent_message:obrigado",
      "user_message:slow essay", "agent_message:lento…:incomplete",
    ]);
    // The end of the run wrote everything streamed so far, not just the first throttled chunk.
    expect(page.items.at(-1)!.text!.length).toBeGreaterThan(5);
    expect(page.items.find(item => item.kind === "command")!.command).toBe("touch /tmp/e2-approval-probe");
    expect(page.items.find(item => item.approval?.actionType === "question")!.approval).toMatchObject({ questions: ["A ou B?"], answers: { "A ou B?": "B" } });
    expect(new Set(page.items.map(item => item.id)).size).toBe(page.items.length);
    // Credentials typed into a prompt are redacted at rest; tool output is never stored.
    expect(page.items[0]!.text).toContain("api_key=[REDACTED]");
    expect(JSON.stringify(page)).not.toContain(SECRET);
    expect(JSON.stringify(page)).not.toContain("feito"); // the fake tool_result text
    // The same page, fetched again (refresh / SSE reconnect), is identical: nothing is appended twice.
    expect(await history(auth, sessionId)).toEqual(page);
    before = page.items;
  });

  test("a turn in flight at shutdown: complete shutdown, restart on the same SQLite, history reappears with the partial marked incomplete", async () => {
    const auth = await login();
    inFlight = (await startRun(auth, sessionId, "slow again")).run_id;
    await until(() => history(auth, sessionId), page => page.items.some(item => item.runId === inFlight && item.kind === "agent_message"));
    await Bun.sleep(60);
    await shutdown(cockpit);
    const raw = await readFile(dbPath);
    expect(raw.includes(Buffer.from(SECRET))).toBe(false); // never written to disk, not even transiently in the main file

    cockpit = boot(); // a new process: new store, new ExecutionService, new adapters; same database file
    const fresh = await login();
    const dashboard = await (await get(fresh, "api/dashboard")).json() as { sessions: Array<{ session_id: string }> };
    expect(dashboard.sessions.map(item => item.session_id)).toContain(sessionId);
    expect(await readRun(fresh, inFlight)()).toMatchObject({ status: "unknown" });
    const page = await history(fresh, sessionId);
    expect(page.items.slice(0, before.length)).toEqual(before);
    expect(shape(page.items.slice(before.length))).toEqual(["user_message:slow again", "agent_message:lento…:incomplete"]);
    expect(page.items.at(-1)!.text!.length).toBeGreaterThan(5); // flushed by the orderly shutdown
    expect(new Set(page.items.map(item => item.id)).size).toBe(page.items.length);
    // Served from SQLite only: no Claude process was started to read it.
    expect(vmWorld.spawned.filter(item => item.argv.includes("stream-json") && !item.ended)).toHaveLength(0);
  });

  test("after the restart the session resumes with context; new turns append once, nothing is duplicated", async () => {
    const auth = await login();
    const run = await startRun(auth, sessionId, "recall the word");
    expect((await waitIdle(auth, run.run_id)).status).toBe("completed");
    const last = vmWorld.spawned.filter(item => item.argv.includes("stream-json")).at(-1)!;
    expect(last.argv).toContain("--resume");
    const page = await history(auth, sessionId);
    expect(shape(page.items.slice(-2))).toEqual(["user_message:recall the word", "agent_message:SEGURANCA"]);
    expect(page.items.length).toBe(before.length + 4);
    expect(new Set(page.items.map(item => item.id)).size).toBe(page.items.length);
    expect(await history(auth, sessionId)).toEqual(page);
  });

  test("pagination walks the whole conversation newest-first without gaps or repeats; malformed queries are refused", async () => {
    const auth = await login();
    const full = (await history(auth, sessionId)).items;
    const pages: Item[][] = [];
    let cursor: string | null = null;
    do {
      const page: Page = await history(auth, sessionId, `?limit=5${cursor ? `&before=${cursor}` : ""}`);
      pages.unshift(page.items);
      cursor = page.next_cursor;
    } while (cursor);
    expect(pages.flat()).toEqual(full);
    expect(pages.at(-1)!.length).toBe(5);
    for (const query of ["?limit=0", "?limit=501", "?before=abc", "?before=1&before=2", "?foo=1", "?limit=5&x=1"]) {
      expect((await get(auth, `api/sessions/${sessionId}/history${query}`)).status).toBe(400);
    }
    expect((await get(auth, "api/dashboard?limit=5")).status).toBe(400); // other routes stay query-free
  });

  test("history needs neither the VM nor Claude: a stopped VM still shows the whole conversation", async () => {
    const auth = await login();
    const full = (await history(auth, sessionId)).items;
    const spawned = vmWorld.spawned.length;
    states["claude-alpha"] = "stopped";
    try {
      const response = await get(auth, `api/sessions/${sessionId}/history`);
      expect(response.status).toBe(200);
      expect((await response.json() as Page).items).toEqual(full);
      expect(vmWorld.spawned.length).toBe(spawned);
    } finally { states["claude-alpha"] = "running"; }
  });
});

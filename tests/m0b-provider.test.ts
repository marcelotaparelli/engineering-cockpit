import { describe, expect, test } from "bun:test";
import { CodexAppServerAdapter } from "../src/codex-adapter.ts";
import type {
  ExecutionTarget, ProviderAdapter, ProviderCapabilities, ProviderConnection, ProviderEvent, RpcId,
  RpcInboundMessage, RpcTransport,
} from "../src/provider.ts";

const target: ExecutionTarget = { provider: "codex", projectId: "demo", vmName: "codex-demo", vmInstanceId: null, discoveryVersion: "snapshot-1" };
const validInitialize = Object.freeze({
  userAgent: "engineering-cockpit/0.163.0 (engineering-cockpit; m0b.1a)",
  codexHome: "/sanitized/codex-home",
  platformFamily: "unix",
  platformOs: "linux",
});

class FakeRpc implements RpcTransport {
  readonly requests: Array<{ method: string; params: Record<string, unknown>; deadlineMs?: number }> = [];
  readonly notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
  readonly responses: Array<{ id: RpcId; result: unknown }> = [];
  readonly inbound: RpcInboundMessage[] = [];
  closed = 0;
  constructor(readonly handle: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>) {}
  async request(method: string, params: Record<string, unknown>, deadlineMs?: number): Promise<unknown> {
    this.requests.push({ method, params, ...(deadlineMs === undefined ? {} : { deadlineMs }) });
    return this.handle(method, params);
  }
  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    this.notifications.push({ method, ...(params === undefined ? {} : { params }) });
  }
  async respond(id: RpcId, result: unknown): Promise<void> { this.responses.push({ id, result }); }
  async *messages(): AsyncIterable<RpcInboundMessage> { for (const message of this.inbound) yield message; }
  async close(): Promise<void> { this.closed++; }
}

describe("typed provider contract and supported Codex mapping", () => {
  test("handshake, sessions, runs, history, interrupt, approval and reconcile stay behind normalized types", async () => {
    const fixture = await Bun.file(new URL("../fixtures/m0b/codex-0.163.0.json", import.meta.url)).json() as {
      initialize: Record<string, unknown>; session: { id: string }; run: { id: string }; historyItem: Record<string, unknown>;
    };
    let reads = 0;
    const rpc = new FakeRpc((method) => {
      if (method === "initialize") return fixture.initialize;
      if (method === "thread/list") return { data: [fixture.session], nextCursor: null };
      if (method === "thread/start" || method === "thread/resume") return { thread: fixture.session };
      if (method === "turn/start") return { turn: fixture.run };
      if (method === "turn/interrupt") return {};
      if (method === "thread/read") {
        reads++;
        return reads === 1
          ? { thread: { turns: [{ id: fixture.run.id, status: "completed", items: [fixture.historyItem] }] }, nextCursor: null }
          : { thread: { turns: [{ id: fixture.run.id, status: "completed", items: [] }] } };
      }
      throw new Error("unexpected fake method");
    });
    const adapter = new CodexAppServerAdapter(() => rpc);
    expect(await adapter.probe()).toEqual({ resume: true, interrupt: true, approvals: true, history: "paged", usage: "session_cumulative" });
    const connection = await adapter.connect(target);
    expect(await connection.initialize()).toEqual({ provider: "codex", protocolVersion: "codex-app-server-jsonl-v1", serverVersion: "0.163.0" });
    expect(rpc.requests[0]?.params).toMatchObject({ clientInfo: { name: "engineering-cockpit", title: "Engineering Cockpit", version: "m0b.1a" } });
    expect(rpc.notifications).toEqual([{ method: "initialized" }]);
    expect((await connection.listSessions()).sessions[0]?.ref.id).toBe(fixture.session.id);
    expect(await connection.startSession({ mode: "new" })).toEqual({ id: fixture.session.id });
    expect(await connection.resumeSession({ id: fixture.session.id })).toEqual({ id: fixture.session.id });
    expect(await connection.startRun({ session: { id: fixture.session.id }, prompt: "synthetic prompt" })).toEqual({ sessionId: fixture.session.id, id: fixture.run.id });
    await connection.interrupt({ sessionId: fixture.session.id, id: fixture.run.id });
    const history = await connection.history({ id: fixture.session.id });
    expect(history.items).toEqual([{ id: "item-1", runId: fixture.run.id, kind: "agent_message", status: null, text: "fixture response", command: null, exitCode: null, files: [] }]);
    expect(history.runs).toEqual([{ id: fixture.run.id, status: "completed" }]);
    expect(await connection.reconcile({ sessionId: fixture.session.id, id: fixture.run.id })).toMatchObject({ status: "completed" });
    rpc.inbound.push(
      { method: "item/commandExecution/requestApproval", params: { threadId: fixture.session.id, turnId: fixture.run.id }, requestId: 73 },
      { method: "item/fileChange/requestApproval", params: { threadId: fixture.session.id, turnId: fixture.run.id }, requestId: 74 },
    );
    for await (const _event of connection.events()) { /* register exact pending handles */ }
    await connection.decideApproval({ sessionId: fixture.session.id, runId: fixture.run.id, requestId: 73 }, "reject");
    await connection.decideApproval({ sessionId: fixture.session.id, runId: fixture.run.id, requestId: 74 }, "approve");
    expect(rpc.responses).toEqual([{ id: 73, result: { decision: "decline" } }, { id: 74, result: { decision: "accept" } }]);
    expect(rpc.requests.find(call => call.method === "thread/start")?.params).toEqual({ cwd: "/workspace", approvalPolicy: "on-request" });
    expect(rpc.requests.find(call => call.method === "turn/start")?.params).toEqual({ threadId: fixture.session.id, input: [{ type: "text", text: "synthetic prompt", text_elements: [] }] });
    expect(JSON.stringify(rpc.requests)).toContain("synthetic prompt");
    await connection.close(); await connection.close(); expect(rpc.closed).toBe(1);
  });

  test("events expose a closed normalized union and ignore unknown provider notifications", async () => {
    const rpc = new FakeRpc(method => method === "initialize" ? validInitialize : {});
    rpc.inbound.push(
      { method: "unknown/provider/detail", params: { raw: "must-not-map" } },
      { method: "turn/started", params: { threadId: "session-provider-1", turn: { id: "run-provider-1" } } },
      { method: "turn/completed", params: { threadId: "session-provider-1", turn: { id: "run-failed", status: "failed" } } },
      { method: "turn/completed", params: { threadId: "session-provider-1", turn: { id: "run-inconclusive" } } },
      { method: "item/commandExecution/requestApproval", params: { threadId: "session-provider-1", turnId: "run-provider-1", command: "not-exposed" }, requestId: "approval-1" },
      { method: "thread/tokenUsage/updated", params: { threadId: "session-provider-1", turnId: "run-provider-1", tokenUsage: { total: { inputTokens: 2, outputTokens: 3, cachedInputTokens: 1, secret: "not-exposed" }, last: { inputTokens: 1 } } } },
    );
    const connection = await new CodexAppServerAdapter(() => rpc).connect(target); await connection.initialize();
    const events: ProviderEvent[] = [];
    for await (const event of connection.events()) events.push(event);
    expect(events.map(event => event.type)).toEqual(["run.started", "run.status_changed", "run.status_changed", "approval.requested", "usage.updated"]);
    expect(events[1]).toMatchObject({ runId: "run-failed", status: "failed" });
    expect(events[2]).toMatchObject({ runId: "run-inconclusive", status: "unknown" });
    const approval = events.find(event => event.type === "approval.requested");
    expect(approval?.approval).toEqual({ sessionId: "session-provider-1", runId: "run-provider-1", requestId: "approval-1" });
    await expect(connection.decideApproval({ sessionId: "wrong-session", runId: "run-provider-1", requestId: "approval-1" }, "approve"))
      .rejects.toThrow("provider_approval_invalid");
    await connection.decideApproval({ sessionId: "session-provider-1", runId: "run-provider-1", requestId: "approval-1" }, "reject");
    await expect(connection.decideApproval({ sessionId: "session-provider-1", runId: "run-provider-1", requestId: "approval-1" }, "reject"))
      .rejects.toThrow("provider_approval_invalid");
    expect(events[4]).toMatchObject({ inputTokens: 2, outputTokens: 3, cachedInputTokens: 1 });
    // The command is surfaced transiently so the operator can decide; it is never journaled (see runtime tests).
    expect(approval?.summary).toEqual({ actionType: "command", itemId: null, command: "not-exposed", cwd: null, reason: null });
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  test("unsupported capabilities and raw transport failures produce stable safe errors", async () => {
    const capabilities: ProviderCapabilities = { resume: false, interrupt: false, approvals: false, history: "none", usage: "none" };
    const rpc = new FakeRpc(method => {
      if (method === "initialize") return validInitialize;
      throw new Error("SYNTHETIC_PROVIDER_SECRET");
    });
    const connection = await new CodexAppServerAdapter(() => rpc, capabilities).connect(target); await connection.initialize();
    await expect(connection.resumeSession({ id: "provider-session" })).rejects.toThrow("provider_capability_unsupported");
    await expect(connection.interrupt({ sessionId: "provider-session", id: "provider-run" })).rejects.toThrow("provider_capability_unsupported");
    await expect(connection.history({ id: "provider-session" })).rejects.toThrow("provider_capability_unsupported");
    await expect(connection.listSessions()).rejects.toThrow("provider_request_failed");
    try { await connection.listSessions(); throw new Error("expected_failure"); }
    catch (error) { expect(String(error)).not.toContain("SYNTHETIC_PROVIDER_SECRET"); }
  });

  test("0.164.0 identity and real-shaped thread/list are mapped from the observed token and fields", async () => {
    const fixture = await Bun.file(new URL("../fixtures/m0b/codex-0.164.0.json", import.meta.url)).json() as {
      initialize: Record<string, unknown>;
      session: { id: string; status: Record<string, unknown>; updatedAt: number };
    };
    const rpc = new FakeRpc(method => {
      if (method === "initialize") return fixture.initialize;
      if (method === "thread/list") return { data: [fixture.session], nextCursor: null };
      return {};
    });
    const connection = await new CodexAppServerAdapter(() => rpc).connect(target);
    expect(await connection.initialize()).toEqual({
      provider: "codex", protocolVersion: "codex-app-server-jsonl-v1", serverVersion: "0.164.0",
    });
    expect(await connection.listSessions(undefined, 1)).toEqual({
      sessions: [{ ref: { id: "session-provider-164" }, status: "active", updatedAt: "2026-10-25T00:00:00.000Z" }],
      nextCursor: null,
    });
    await connection.close();
  });

  test("target confusion is denied before transport creation", async () => {
    let calls = 0; const adapter = new CodexAppServerAdapter(() => { calls++; throw new Error("must not connect"); });
    await expect(adapter.connect({ ...target, projectId: "other" })).rejects.toThrow("provider_target_invalid");
    await expect(adapter.connect({ ...target, provider: "claude" })).rejects.toThrow("provider_target_invalid");
    expect(calls).toBe(0);
  });

  test("initialize validates the pinned real response without leaking rejected values", async () => {
    const uaCanary = "UA_SECRET_CANARY";
    const homeCanary = "/HOME_SECRET_CANARY";
    const cases: Array<{ response: unknown; code: string }> = [
      { response: { ...validInitialize, userAgent: `other-product/0.164.0 ${uaCanary}` }, code: "provider_version_unsupported" },
      { response: { ...validInitialize, userAgent: `engineering-cockpit/0.165.0 ${uaCanary}` }, code: "provider_version_unsupported" },
      { response: { ...validInitialize, userAgent: `engineering-cockpit/0.163.0 engineering-cockpit/0.164.0 ${uaCanary}` }, code: "provider_version_unsupported" },
      { response: { ...validInitialize, userAgent: `engineering-cockpit/0.164.0 engineering-cockpit/0.164.0 ${uaCanary}` }, code: "provider_version_unsupported" },
      { response: { ...validInitialize, userAgent: `prefixengineering-cockpit/0.164.0 ${uaCanary}` }, code: "provider_version_unsupported" },
      { response: { ...validInitialize, userAgent: `engineering-cockpit/0.164.0!evil ${uaCanary}` }, code: "provider_version_unsupported" },
      { response: { ...validInitialize, userAgent: `evil!engineering-cockpit/0.164.0 ${uaCanary}` }, code: "provider_version_unsupported" },
      { response: { ...validInitialize, userAgent: `engineering-cockpit/0.164.0:evil ${uaCanary}` }, code: "provider_version_unsupported" },
      { response: { ...validInitialize, userAgent: `éengineering-cockpit/0.164.0 ${uaCanary}` }, code: "provider_version_unsupported" },
      { response: { ...validInitialize, userAgent: `engineering-cockpit/0.164.0é ${uaCanary}` }, code: "provider_version_unsupported" },
      { response: { ...validInitialize, userAgent: `engineering-cockpit build 0.163.0 ${uaCanary}` }, code: "provider_version_unsupported" },
      { response: { ...validInitialize, codexHome: `relative/${homeCanary}` }, code: "provider_initialize_home_invalid" },
      { response: { ...validInitialize, codexHome: `${homeCanary}\0suffix` }, code: "provider_initialize_home_invalid" },
      { response: { ...validInitialize, platformFamily: "windows" }, code: "provider_platform_unsupported" },
      { response: { ...validInitialize, platformOs: "macos" }, code: "provider_platform_unsupported" },
      { response: { ...validInitialize, extra: "schema-drift" }, code: "provider_initialize_shape_invalid" },
      { response: { ...validInitialize, userAgent: 163 }, code: "provider_initialize_shape_invalid" },
      { response: null, code: "provider_initialize_shape_invalid" },
    ];
    for (const fixture of cases) {
      const rpc = new FakeRpc(method => method === "initialize" ? fixture.response : {});
      const connection = await new CodexAppServerAdapter(() => rpc).connect(target);
      try {
        await connection.initialize();
        throw new Error("expected_failure");
      } catch (error) {
        expect(String(error)).toBe(`Error: ${fixture.code}`);
        expect(String(error)).not.toContain(uaCanary);
        expect(String(error)).not.toContain(homeCanary);
      }
      expect(rpc.notifications).toEqual([]);
      await connection.close();
    }
  });

  test("thread/list maps the v2 status object and Unix-second timestamp narrowly", async () => {
    const rows = [
      { id: "active", status: { type: "active", activeFlags: ["waitingOnApproval", "waitingOnUserInput"] }, updatedAt: 1770000000 },
      { id: "idle", status: { type: "idle" }, updatedAt: 0 },
      { id: "not-loaded", status: { type: "notLoaded" }, updatedAt: 1 },
      { id: "system-error", status: { type: "systemError" }, updatedAt: 2 },
    ];
    const rpc = new FakeRpc(method => {
      if (method === "initialize") return validInitialize;
      if (method === "thread/list") return { data: rows, nextCursor: null };
      return {};
    });
    const connection = await new CodexAppServerAdapter(() => rpc).connect(target);
    await connection.initialize();
    const page = await connection.listSessions(undefined, 4);
    expect(page.sessions.map(session => session.status)).toEqual(["active", "idle", "unknown", "unknown"]);
    expect(page.sessions.map(session => session.updatedAt)).toEqual([
      "2026-02-02T02:40:00.000Z",
      "1970-01-01T00:00:00.000Z",
      "1970-01-01T00:00:01.000Z",
      "1970-01-01T00:00:02.000Z",
    ]);
    await connection.close();
  });

  test("thread/list rejects malformed status and timestamps without exposing thread data", async () => {
    const secret = "THREAD_SECRET_CANARY";
    const invalidRows = [
      { id: secret, status: { type: "active" }, updatedAt: 1 },
      { id: secret, status: { type: "active", activeFlags: [secret] }, updatedAt: 1 },
      { id: secret, status: { type: "idle", activeFlags: [] }, updatedAt: 1 },
      { id: secret, status: "idle", updatedAt: 1 },
      { id: secret, status: { type: "future" }, updatedAt: 1 },
      { id: secret, status: { type: "idle" }, updatedAt: -1 },
      { id: secret, status: { type: "idle" }, updatedAt: 1.5 },
      { id: secret, status: { type: "idle" }, updatedAt: "1770000000" },
    ];
    for (const row of invalidRows) {
      const rpc = new FakeRpc(method => {
        if (method === "initialize") return validInitialize;
        if (method === "thread/list") return { data: [row], nextCursor: null };
        return {};
      });
      const connection = await new CodexAppServerAdapter(() => rpc).connect(target);
      await connection.initialize();
      try {
        await connection.listSessions(undefined, 1);
        throw new Error("expected_failure");
      } catch (error) {
        expect(String(error)).toBe("Error: provider_response_invalid");
        expect(String(error)).not.toContain(secret);
      }
      await connection.close();
    }
  });

  test("a non-Codex fake uses only the provider-neutral contract", async () => {
    const events: ProviderEvent[] = [];
    const connection: ProviderConnection = {
      async initialize() { return { provider: "claude", protocolVersion: "fake-v1", serverVersion: "fake" }; },
      async listSessions() { return { sessions: [], nextCursor: null }; },
      async startSession() { return { id: "synthetic-session" }; },
      async resumeSession(ref) { return ref; },
      async startRun(input) { return { sessionId: input.session.id, id: "synthetic-run" }; },
      async interrupt() {}, async decideApproval() {},
      async history() { return { items: [], runs: [], nextCursor: null }; },
      async reconcile() { return { status: "unknown", observedAt: "2026-10-25T00:00:00Z" }; },
      async *events() { for (const event of events) yield event; }, async close() {},
    };
    const fake: ProviderAdapter = {
      provider: "claude",
      async probe() { return { resume: true, interrupt: true, approvals: false, history: "paged", usage: "none" }; },
      async connect() { return connection; },
    };
    const connected = await fake.connect({ ...target, provider: "claude", vmName: "claude-demo" });
    const session = await connected.startSession({ mode: "new" });
    expect(await connected.startRun({ session, prompt: "synthetic" })).toEqual({ sessionId: "synthetic-session", id: "synthetic-run" });
  });
});

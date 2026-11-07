import { describe, expect, test } from "bun:test";
import { runM0b1aSmoke, type M0b1aSmokeOverrides } from "../src/m0b1a-smoke.ts";
import type { RpcId, RpcInboundMessage, RpcTransport } from "../src/provider.ts";

const arch = { platform: "linux", osRelease: 'NAME="Arch Linux"\nID=arch\n', knownGuest: false };
const consent = {
  COCKPIT_MODE: "host",
  COCKPIT_HOST_CONFIRMED: "yes",
  COCKPIT_M0B1A_SMOKE_CONFIRMED: "yes",
  COCKPIT_SMOKE_VM: "codex-demo",
  SECRET_CANARY: "ENV_MUST_NOT_LEAK",
};
const inventory = JSON.stringify([{
  created_at: "2026-10-25T00:00:00Z", image: "synthetic", name: "codex-demo", status: "Running",
}]);
const validInitialize = Object.freeze({
  userAgent: "engineering-cockpit/0.163.0 (engineering-cockpit; m0b.1a)",
  codexHome: "/sanitized/codex-home",
  platformFamily: "unix",
  platformOs: "linux",
});

class FakeTransport implements RpcTransport {
  readonly calls: Array<{ kind: "request" | "notify"; method: string; params?: Record<string, unknown> }> = [];
  closed = 0;
  constructor(readonly listData: unknown[] = [{ id: "PROVIDER_SESSION_CANARY", status: { type: "idle" }, updatedAt: 1792886400 }], readonly initialize: unknown = validInitialize, readonly failMethod?: string) {}
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ kind: "request", method, params });
    if (method === this.failMethod) throw new Error("TRANSPORT_SECRET_CANARY");
    if (method === "initialize") return this.initialize;
    if (method === "thread/list") return { data: this.listData, nextCursor: null };
    throw new Error(`unexpected:${method}`);
  }
  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    this.calls.push({ kind: "notify", method, ...(params === undefined ? {} : { params }) });
    if (method === this.failMethod) throw new Error("TRANSPORT_SECRET_CANARY");
  }
  async respond(_id: RpcId, _result: unknown): Promise<void> { throw new Error("respond forbidden"); }
  async *messages(): AsyncIterable<RpcInboundMessage> { /* no events in smoke */ }
  async close(): Promise<void> { this.closed++; }
}

function setup(transport = new FakeTransport()): { overrides: M0b1aSmokeOverrides; counts: { list: number; spawn: number }; transport: FakeTransport } {
  const counts = { list: 0, spawn: 0 };
  return {
    counts,
    transport,
    overrides: {
      facts: arch,
      env: { ...consent },
      readOutput: async () => { counts.list++; return inventory; },
      transportFactory: () => { counts.spawn++; return transport; },
    },
  };
}

describe("M0b.1a Arch smoke", () => {
  test("missing consent stops before inventory and transport", async () => {
    for (const missing of ["COCKPIT_MODE", "COCKPIT_HOST_CONFIRMED", "COCKPIT_M0B1A_SMOKE_CONFIRMED", "COCKPIT_SMOKE_VM"] as const) {
      const h = setup();
      delete h.overrides.env[missing];
      const report = await runM0b1aSmoke(h.overrides);
      expect(report.overall).toBe("NOT_VERIFIED");
      expect(h.counts).toEqual({ list: 0, spawn: 0 });
    }
  });

  test("non-Arch and guest facts stop before inventory and transport", async () => {
    for (const facts of [{ ...arch, platform: "darwin" }, { ...arch, knownGuest: true }]) {
      const h = setup(); h.overrides.facts = facts;
      expect((await runM0b1aSmoke(h.overrides)).overall).toBe("NOT_VERIFIED");
      expect(h.counts).toEqual({ list: 0, spawn: 0 });
    }
  });

  test("absent and stopped exact targets never create the transport", async () => {
    for (const output of ["[]", inventory.replace("Running", "Stopped")]) {
      const h = setup(); h.overrides.readOutput = async () => { h.counts.list++; return output; };
      const report = await runM0b1aSmoke(h.overrides);
      expect(report.overall).toBe("NOT_VERIFIED");
      expect(h.counts).toEqual({ list: 1, spawn: 0 });
    }
  });

  test("success performs only initialize, initialized and bounded thread/list, then closes once", async () => {
    const h = setup();
    const report = await runM0b1aSmoke(h.overrides);
    expect(report.overall).toBe("PASS");
    expect(h.transport.calls).toEqual([
      { kind: "request", method: "initialize", params: { clientInfo: { name: "engineering-cockpit", title: "Engineering Cockpit", version: "m0b.1a" }, capabilities: {} } },
      { kind: "notify", method: "initialized" },
      { kind: "request", method: "thread/list", params: { limit: 1 } },
    ]);
    expect(h.transport.calls.some(call => /thread\/(?:start|resume|read)|turn\//.test(call.method))).toBe(false);
    expect(h.transport.closed).toBe(1);
    expect(report.checks.find(check => check.id === "initialize")).toMatchObject({
      provider: "codex", server_version: "0.163.0", protocol_version: "codex-app-server-jsonl-v1",
    });
    expect(report.checks.find(check => check.id === "thread_list")).toMatchObject({ sessions_returned: 1 });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("codex-demo");
    expect(serialized).not.toContain("PROVIDER_SESSION_CANARY");
    expect(serialized).not.toContain("ENV_MUST_NOT_LEAK");
    expect(Object.keys(report)).toEqual(["milestone", "source", "timestamp", "overall", "checks"]);
  });

  test("0.164.0 passes the same read-only smoke contract and reports the observed version", async () => {
    const initialize164 = {
      ...validInitialize,
      userAgent: "engineering-cockpit/0.164.0 (engineering-cockpit; m0b.1a)",
    };
    const h = setup(new FakeTransport(
      [{ id: "PROVIDER_SESSION_CANARY", status: { type: "idle" }, updatedAt: 1792886400 }],
      initialize164,
    ));
    const report = await runM0b1aSmoke(h.overrides);
    expect(report.overall).toBe("PASS");
    expect(report.checks.find(check => check.id === "initialize")).toMatchObject({
      provider: "codex", server_version: "0.164.0", protocol_version: "codex-app-server-jsonl-v1",
    });
    expect(h.transport.calls.map(call => `${call.kind}:${call.method}`)).toEqual([
      "request:initialize", "notify:initialized", "request:thread/list",
    ]);
    expect(h.transport.closed).toBe(1);
  });

  test("session overflow, unsupported version and transport errors fail safely and close", async () => {
    const cases = [
      new FakeTransport([
        { id: "one", status: { type: "idle" }, updatedAt: 1 },
        { id: "two", status: { type: "notLoaded" }, updatedAt: 2 },
      ]),
      new FakeTransport([], { ...validInitialize, userAgent: "engineering-cockpit/0.999.0" }),
      new FakeTransport([], undefined, "thread/list"),
    ];
    for (const transport of cases) {
      const h = setup(transport);
      const report = await runM0b1aSmoke(h.overrides);
      expect(report.overall).toBe("FAIL");
      expect(transport.closed).toBe(1);
      expect(JSON.stringify(report)).not.toContain("TRANSPORT_SECRET_CANARY");
    }
  });

  test("invalid initialize diagnostics are structured and do not expose UA, path or IDs", async () => {
    const transport = new FakeTransport([], {
      ...validInitialize,
      userAgent: "WRONG_PRODUCT/0.163.0 UA_SECRET_CANARY",
      codexHome: "/PATH_SECRET_CANARY",
    });
    const h = setup(transport);
    const report = await runM0b1aSmoke(h.overrides);
    expect(report.overall).toBe("FAIL");
    expect(transport.closed).toBe(1);
    expect(JSON.stringify(report)).not.toContain("UA_SECRET_CANARY");
    expect(JSON.stringify(report)).not.toContain("PATH_SECRET_CANARY");
    expect(JSON.stringify(report)).not.toContain("PROVIDER_SESSION_CANARY");
    expect(report.checks.find(check => check.id === "initialize")?.reason).toBe("provider_version_unsupported");
  });
});

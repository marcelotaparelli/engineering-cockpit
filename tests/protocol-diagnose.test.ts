import { describe, expect, test } from "bun:test";
import { runProtocolDiagnosis, compareShapes, type DiagnoseOverrides } from "../src/protocol-diagnose.ts";
import { CodexAppServerAdapter } from "../src/codex-adapter.ts";
import type { RpcId, RpcInboundMessage, RpcTransport } from "../src/provider.ts";

const arch = { platform: "linux", osRelease: 'NAME="Arch Linux"\nID=arch\n', knownGuest: false };
const env = { COCKPIT_MODE: "host", COCKPIT_HOST_CONFIRMED: "yes", COCKPIT_E0_DIAGNOSE_CONFIRMED: "yes", COCKPIT_DIAGNOSE_VM: "codex-e0-test", SECRET_CANARY: "ENV_MUST_NOT_LEAK" };
const inventory = (status = "Running") => JSON.stringify([{ created_at: "2026-10-25T00:00:00Z", image: "synthetic", name: "codex-e0-test", status }]);
const fixture = await Bun.file(new URL("../fixtures/m0b/codex-0.166.0.json", import.meta.url)).json() as { initialize: Record<string, unknown>; listResponse: Record<string, unknown> };

class Fake implements RpcTransport {
  calls: string[] = []; closed = 0;
  constructor(readonly init: unknown = fixture.initialize, readonly list: unknown = fixture.listResponse) {}
  async request(method: string): Promise<unknown> { this.calls.push(method); return method === "initialize" ? this.init : this.list; }
  async notify(method: string): Promise<void> { this.calls.push(method); }
  async respond(_id: RpcId, _r: unknown): Promise<void> { throw new Error("respond forbidden"); }
  async *messages(): AsyncIterable<RpcInboundMessage> { /* none */ }
  async close(): Promise<void> { this.closed++; }
}
function setup(transport = new Fake(), status = "Running", over: Partial<DiagnoseOverrides["env"]> = {}) {
  const counts = { spawn: 0 };
  const overrides: DiagnoseOverrides = { facts: arch, env: { ...env, ...over }, readOutput: async () => inventory(status), transportFactory: () => { counts.spawn++; return transport; } };
  return { overrides, counts, transport };
}

describe("E0 protocol diagnostic", () => {
  test("0.166.0 real-shaped responses: pinned, additive fields are non-blocking, only read-only methods", async () => {
    const h = setup();
    const report = await runProtocolDiagnosis(h.overrides);
    expect(report.overall).toBe("PASS");
    expect(report.server_version).toBe("0.166.0");
    expect(report.version_pinned).toBe(true);
    expect(report.divergences.every(item => !item.blocking)).toBe(true);
    expect(report.divergences.some(item => item.name === "readStates")).toBe(true);
    expect(h.transport.calls).toEqual(["initialize", "initialized", "thread/list"]);
    expect(h.transport.closed).toBe(1);
    const text = JSON.stringify(report);
    for (const secret of ["session-provider-166", "sanitized", "ENV_MUST_NOT_LEAK", "codex-e0-test", "Arch Linux"]) expect(text).not.toContain(secret);
  });

  test("unpinned version with identical shape fails as version_not_pinned", async () => {
    const h = setup(new Fake({ ...fixture.initialize, userAgent: "engineering-cockpit/0.167.0 (x)" }));
    const report = await runProtocolDiagnosis(h.overrides);
    expect(report).toMatchObject({ overall: "FAIL", reason: "version_not_pinned", server_version: "0.167.0", version_pinned: false });
  });

  test("structural drift is reported by field name only", async () => {
    const drift: Record<string, unknown> = { ...fixture.initialize, serverInfo: "SECRET_VALUE" }; delete drift.platformOs;
    const h = setup(new Fake(drift, { data: [{ id: 5, status: { type: "brandNew" }, updatedAt: "x", leak: "SECRET_VALUE" }] }));
    const report = await runProtocolDiagnosis(h.overrides);
    expect(report).toMatchObject({ overall: "FAIL", reason: "structural_divergence" });
    const keys = report.divergences.filter(item => item.blocking).map(item => `${item.where}:${item.kind}:${item.name}`);
    expect(keys).toEqual(expect.arrayContaining([
      "initialize:missing:platformOs", "initialize:additive:serverInfo", "thread/list.data[]:missing:id",
      "thread/list.data[]:unexpected_type:updatedAt", "thread/list.data[].status:unknown_enum:type",
    ]));
    expect(JSON.stringify(report)).not.toContain("SECRET_VALUE");
  });

  test("unsafe field names are masked", () => {
    const { divergences } = compareShapes({ ...fixture.initialize, "bad name\n/secret": 1 }, fixture.listResponse);
    expect(divergences.some(item => item.name === "<invalid-name>")).toBe(true);
    expect(JSON.stringify(divergences)).not.toContain("secret");
  });

  test("missing consent, wrong provider, absent or stopped VM never create a transport", async () => {
    for (const [over, status, reason] of [
      [{ COCKPIT_E0_DIAGNOSE_CONFIRMED: undefined }, "Running", "diagnose_confirmation_required"],
      [{ COCKPIT_DIAGNOSE_VM: "claude-e0-test" }, "Running", "diagnose_target_invalid"],
      [{ COCKPIT_DIAGNOSE_VM: "codex-other" }, "Running", "diagnose_target_absent"],
      [{}, "Stopped", "diagnose_target_not_running"],
    ] as const) {
      const h = setup(new Fake(), status, over);
      const report = await runProtocolDiagnosis(h.overrides);
      expect(report).toMatchObject({ overall: "NOT_VERIFIED", reason });
      expect(h.counts.spawn).toBe(0);
    }
  });

  test("adapter accepts the 0.166.0 fixture and still rejects 0.165.0 and 0.167.0", async () => {
    const target = { provider: "codex" as const, projectId: "e0-test", vmName: "codex-e0-test", vmInstanceId: null, discoveryVersion: "v" };
    const ok = await new CodexAppServerAdapter(() => new Fake()).connect(target);
    expect(await ok.initialize()).toEqual({ provider: "codex", protocolVersion: "codex-app-server-jsonl-v1", serverVersion: "0.166.0" });
    expect(await ok.listSessions(undefined, 1)).toEqual({
      sessions: [{ ref: { id: "session-provider-166" }, status: "idle", updatedAt: "2026-10-25T00:00:00.000Z" }], nextCursor: null,
    });
    for (const version of ["0.165.0", "0.167.0"]) {
      const bad = await new CodexAppServerAdapter(() => new Fake({ ...fixture.initialize, userAgent: `engineering-cockpit/${version} (x)` })).connect(target);
      await expect(bad.initialize()).rejects.toMatchObject({ code: "provider_version_unsupported" });
    }
  });
});

import { classifyCodexError } from "../src/codex-adapter.ts";
test("codexErrorInfo is classified from structured codes only, never from message text", () => {
  expect(classifyCodexError({ message: "x", codexErrorInfo: "usageLimitExceeded" })).toBe("usage_limit");
  expect(classifyCodexError({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } })).toBe("transport");
  expect(classifyCodexError({ codexErrorInfo: "unauthorized" })).toBe("auth");
  expect(classifyCodexError({ message: "usage limit exceeded, 401 unauthorized" })).toBeNull();
  expect(classifyCodexError({ codexErrorInfo: "somethingNew" })).toBeNull();
  expect(classifyCodexError({ codexErrorInfo: { __proto__: 1, constructor: 1 } })).toBeNull();
  expect(classifyCodexError(null)).toBeNull();
});

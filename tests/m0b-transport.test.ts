import { describe, expect, test } from "bun:test";
import { CodexAppServerAdapter } from "../src/codex-adapter.ts";
import { JsonlObjectParser } from "../src/jsonl.ts";
import { MsbStdioTransport, type MsbChild, type MsbSpawn, type MsbSpawnOptions } from "../src/msb-transport.ts";
import type { ExecutionTarget } from "../src/provider.ts";

const encoder = new TextEncoder();

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function controlled() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancellations = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { cancellations++; },
  });
  return { stream, enqueue: (value: string | Uint8Array) => controller.enqueue(typeof value === "string" ? encoder.encode(value) : value), close: () => controller.close(), cancellations: () => cancellations };
}

function harness(options: { stallWrite?: boolean } = {}) {
  const stdout = controlled(); const stderr = controlled(); const exited = deferred<number>();
  const writes: string[] = []; const kills: string[] = []; let ends = 0;
  let argv: readonly string[] = []; let spawnOptions: MsbSpawnOptions | undefined;
  const child: MsbChild = {
    stdout: stdout.stream, stderr: stderr.stream, exited: exited.promise,
    stdin: {
      write(data) { writes.push(new TextDecoder().decode(data)); return options.stallWrite ? new Promise<number>(() => {}) : data.byteLength; },
      end() { ends++; },
    },
    kill(signal) { kills.push(signal); },
  };
  const spawn: MsbSpawn = (receivedArgv, receivedOptions) => { argv = receivedArgv; spawnOptions = receivedOptions; return child; };
  return { spawn, stdout, stderr, exited, writes, kills, argv: () => argv, options: () => spawnOptions, ends: () => ends };
}

async function outbound(h: ReturnType<typeof harness>, index = 0): Promise<Record<string, unknown>> {
  for (let attempts = 0; attempts < 100 && !h.writes[index]; attempts++) await Bun.sleep(1);
  const value = h.writes[index];
  if (!value) throw new Error("missing_fake_write");
  return JSON.parse(value) as Record<string, unknown>;
}

describe("incremental JSONL parser", () => {
  test("accepts split UTF-8, CRLF, and only object frames", () => {
    const parser = new JsonlObjectParser(128, 256);
    const bytes = encoder.encode('{"text":"olá"}\r\n');
    const utf8Lead = bytes.indexOf(0xc3);
    expect(parser.push(bytes.slice(0, utf8Lead + 1))).toEqual([]);
    expect(parser.push(bytes.slice(utf8Lead + 1))).toEqual([{ text: "olá" }]);
    expect(parser.finish()).toEqual([]);
    expect(() => new JsonlObjectParser().push(encoder.encode("[]\n"))).toThrow("jsonl_object_required");
  });

  test("fixtures reproduce malformed, oversized, invalid UTF-8 and partial EOF", async () => {
    const success = await Bun.file(new URL("../fixtures/m0b/success.jsonl", import.meta.url)).bytes();
    expect(new JsonlObjectParser().push(success)).toHaveLength(2);
    const malformed = await Bun.file(new URL("../fixtures/m0b/malformed.jsonl", import.meta.url)).bytes();
    expect(() => new JsonlObjectParser().push(malformed)).toThrow("jsonl_malformed");
    const oversized = await Bun.file(new URL("../fixtures/m0b/oversized.json", import.meta.url)).json() as { maxFrameBytes: number; payloadBytes: number; expectedCode: string };
    expect(() => new JsonlObjectParser(oversized.maxFrameBytes, oversized.maxFrameBytes * 2)
      .push(encoder.encode(`${"x".repeat(oversized.payloadBytes)}\n`))).toThrow(oversized.expectedCode);
    expect(() => new JsonlObjectParser().push(Uint8Array.of(0xff, 10))).toThrow("jsonl_invalid_utf8");
    const partial = new JsonlObjectParser(); partial.push(encoder.encode('{"ok":true}'));
    expect(() => partial.finish()).toThrow("jsonl_partial_frame");
  });
});

describe("isolated MSB stdio transport", () => {
  test("uses exact argv, pipe IO, minimal environment and full-duplex correlation", async () => {
    const h = harness();
    const transport = new MsbStdioTransport("codex-demo", h.spawn, { env: { PATH: "/bin", LANG: "C", API_TOKEN: "secret" }, shutdownGraceMs: 5 });
    const request = transport.request("fixture/ping", { value: 1 });
    const frame = await outbound(h);
    expect(h.argv()).toEqual(["msb", "exec", "--stream", "codex-demo", "--", "codex", "app-server", "--listen", "stdio://"]);
    expect(h.options()).toEqual({ stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: "/bin", LANG: "C" } });
    expect(frame).not.toHaveProperty("jsonrpc");
    h.stdout.enqueue(`${JSON.stringify({ id: frame.id, result: { pong: true } })}\n`);
    expect(await request).toEqual({ pong: true });
    const event = transport.messages()[Symbol.asyncIterator]().next();
    h.stdout.enqueue('{"method":"fixture/event","params":{"ok":true}}\n');
    expect((await event).value).toEqual({ method: "fixture/event", params: { ok: true } });
    h.exited.resolve(0); await transport.close();
  });

  test("rejects invalid targets before spawn", () => {
    let calls = 0;
    expect(() => new MsbStdioTransport("claude-demo", () => { calls++; return harness().spawn([], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} }); })).toThrow("invalid_transport_target");
    expect(() => new MsbStdioTransport("codex-../escape", () => { throw new Error("must not run"); })).toThrow("invalid_vm_name");
    expect(calls).toBe(0);
  });

  test("deadline retires the ID and a late response fails closed without resolving a newer request", async () => {
    const h = harness(); const transport = new MsbStdioTransport("codex-demo", h.spawn, { requestDeadlineMs: 5, shutdownGraceMs: 5 });
    const first = transport.request("fixture/slow", {}, 5); const firstFrame = await outbound(h);
    await expect(first).rejects.toThrow("rpc_deadline_exceeded");
    const second = transport.request("fixture/next", {}, 100); const secondFrame = await outbound(h, 1);
    expect(secondFrame.id).not.toBe(firstFrame.id);
    h.stdout.enqueue(`${JSON.stringify({ id: firstFrame.id, result: {} })}\n`);
    await expect(second).rejects.toThrow("rpc_duplicate_response");
    await transport.close();
  });

  test("outbound frames use the same byte limit", async () => {
    const h = harness(); const transport = new MsbStdioTransport("codex-demo", h.spawn, { maxFrameBytes: 64, maxBufferBytes: 128, shutdownGraceMs: 5 });
    await expect(transport.request("fixture/large", { value: "é".repeat(64) })).rejects.toThrow("rpc_frame_limit");
    expect(h.writes).toEqual([]);
    await transport.close();
  });

  test("EOF rejects pending requests and malformed correlation fails closed", async () => {
    const h = harness(); const transport = new MsbStdioTransport("codex-demo", h.spawn, { shutdownGraceMs: 5 });
    const pending = transport.request("fixture/wait", {}); await outbound(h);
    h.stdout.close();
    await expect(pending).rejects.toThrow("transport_eof");
    await transport.close();

    const other = harness(); const invalid = new MsbStdioTransport("codex-demo", other.spawn, { shutdownGraceMs: 5 });
    const waiting = invalid.request("fixture/wait", {}); await outbound(other);
    other.stdout.enqueue('{"id":"RPC_ID_SECRET_CANARY","result":{}}\n');
    try { await waiting; throw new Error("expected_failure"); }
    catch (error) {
      expect(String(error)).toBe("Error: rpc_unknown_response");
      expect(String(error)).not.toContain("RPC_ID_SECRET_CANARY");
    }
    await invalid.close();
  });

  test("stderr is bounded and raw secret never enters the safe error", async () => {
    const h = harness(); const transport = new MsbStdioTransport("codex-demo", h.spawn, { maxStderrBytes: 8, shutdownGraceMs: 5 });
    const pending = transport.request("fixture/wait", {}); await outbound(h);
    h.stderr.enqueue(await Bun.file(new URL("../fixtures/m0b/stderr-secret.txt", import.meta.url)).text());
    try { await pending; throw new Error("expected_failure"); }
    catch (error) { expect(String(error)).toBe("Error: msb_stderr_limit"); expect(String(error)).not.toContain("SYNTHETIC"); }
    await transport.close();
  });

  test("an unconsumed notification flood is bounded and fails the transport closed", async () => {
    const h = harness();
    const transport = new MsbStdioTransport("codex-demo", h.spawn, { maxInboundMessages: 1, shutdownGraceMs: 5 });
    const pending = transport.request("fixture/wait", {}); await outbound(h);
    h.stdout.enqueue(
      '{"method":"fixture/one","params":{}}\n' +
      '{"method":"fixture/two","params":{}}\n',
    );
    await expect(pending).rejects.toThrow("rpc_inbound_queue_limit");
    const iterator = transport.messages()[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ method: "fixture/one" });
    await expect(iterator.next()).rejects.toThrow("rpc_inbound_queue_limit");
    await transport.close();
  });

  test("concurrent close is idempotent and bounded when writes and child stall", async () => {
    const h = harness({ stallWrite: true });
    const transport = new MsbStdioTransport("codex-demo", h.spawn, { requestDeadlineMs: 5, shutdownGraceMs: 5 });
    const pending = transport.request("fixture/stall", {}, 5); await outbound(h);
    await expect(pending).rejects.toThrow("rpc_deadline_exceeded");
    await Promise.all([transport.close(), transport.close(), transport.close()]);
    expect(h.ends()).toBe(1);
    expect(h.kills).toEqual(["SIGKILL"]);
    expect(h.stdout.cancellations()).toBe(1);
    expect(h.stderr.cancellations()).toBe(1);
  });

  test("real sanitized initialize envelope and async notifications interoperate with the adapter", async () => {
    // Sanitized from the Arch 0.163.0 response that exposed the missing-jsonrpc failure.
    const fixture = await Bun.file(new URL("../fixtures/m0b/codex-0.163.0-initialize-response.json", import.meta.url)).json() as {
      id: string;
      result: Record<string, unknown>;
    };
    const h = harness();
    const transport = new MsbStdioTransport("codex-demo", h.spawn, { shutdownGraceMs: 5 });
    const target: ExecutionTarget = {
      provider: "codex", projectId: "demo", vmName: "codex-demo", vmInstanceId: null, discoveryVersion: "fixture",
    };
    const connection = await new CodexAppServerAdapter(() => transport).connect(target);

    const initialize = connection.initialize();
    const initializeRequest = await outbound(h, 0);
    expect(initializeRequest).toMatchObject({ method: "initialize" });
    expect(initializeRequest).not.toHaveProperty("jsonrpc");
    h.stdout.enqueue('{"method":"account/updated","params":{"authMode":"sanitized"},"emittedAtMs":1770000000000}\n');
    h.stdout.enqueue(`${JSON.stringify({ ...fixture, id: initializeRequest.id })}\n`);
    expect(await initialize).toEqual({
      provider: "codex", protocolVersion: "codex-app-server-jsonl-v1", serverVersion: "0.163.0",
    });
    expect(await outbound(h, 1)).toEqual({ method: "initialized" });

    const list = connection.listSessions(undefined, 1);
    const listRequest = await outbound(h, 2);
    expect(listRequest).toMatchObject({ method: "thread/list", params: { limit: 1 } });
    h.stdout.enqueue('{"method":"thread/status/changed","params":{"threadId":"SANITIZED"}}\n');
    h.stdout.enqueue(`${JSON.stringify({
      id: listRequest.id,
      result: {
        data: [{ id: "SANITIZED_THREAD_ID", status: { type: "active", activeFlags: ["waitingOnApproval"] }, updatedAt: 1770000000 }],
        nextCursor: null,
      },
    })}\n`);
    expect(await list).toEqual({
      sessions: [{ ref: { id: "SANITIZED_THREAD_ID" }, status: "active", updatedAt: "2026-02-02T02:40:00.000Z" }],
      nextCursor: null,
    });

    const events = transport.messages()[Symbol.asyncIterator]();
    expect((await events.next()).value).toEqual({ method: "account/updated", params: { authMode: "sanitized" } });
    expect((await events.next()).value).toMatchObject({ method: "thread/status/changed" });
    await connection.close();
  });

  test("real-shaped 0.164.0 initialize and thread/list interoperate through MSB transport", async () => {
    const fixture = await Bun.file(new URL("../fixtures/m0b/codex-0.164.0-initialize-response.json", import.meta.url)).json() as {
      id: string;
      result: Record<string, unknown>;
    };
    const providerFixture = await Bun.file(new URL("../fixtures/m0b/codex-0.164.0.json", import.meta.url)).json() as {
      session: Record<string, unknown>;
    };
    const h = harness();
    const transport = new MsbStdioTransport("codex-demo", h.spawn, { shutdownGraceMs: 5 });
    const target: ExecutionTarget = {
      provider: "codex", projectId: "demo", vmName: "codex-demo", vmInstanceId: null, discoveryVersion: "fixture",
    };
    const connection = await new CodexAppServerAdapter(() => transport).connect(target);

    const initialize = connection.initialize();
    const initializeRequest = await outbound(h, 0);
    h.stdout.enqueue(`${JSON.stringify({ ...fixture, id: initializeRequest.id })}\n`);
    expect(await initialize).toEqual({
      provider: "codex", protocolVersion: "codex-app-server-jsonl-v1", serverVersion: "0.164.0",
    });
    expect(await outbound(h, 1)).toEqual({ method: "initialized" });

    const list = connection.listSessions(undefined, 1);
    const listRequest = await outbound(h, 2);
    expect(listRequest).toMatchObject({ method: "thread/list", params: { limit: 1 } });
    h.stdout.enqueue(`${JSON.stringify({
      id: listRequest.id,
      result: { data: [providerFixture.session], nextCursor: null },
    })}\n`);
    expect(await list).toEqual({
      sessions: [{ ref: { id: "session-provider-164" }, status: "active", updatedAt: "2026-10-25T00:00:00.000Z" }],
      nextCursor: null,
    });
    await connection.close();
  });

  test("rejects legacy jsonrpc and ambiguous or malformed Codex envelopes", async () => {
    const frames: Array<(id: unknown) => Record<string, unknown>> = [
      id => ({ jsonrpc: "2.0", id, result: {} }),
      id => ({ id, result: {}, error: { code: -1, message: "ambiguous" } }),
      () => ({ method: "", params: {} }),
      () => ({ method: "fixture/event", params: [] }),
      () => ({ id: {}, method: "fixture/event", params: {} }),
      () => ({ id: "", method: "fixture/event", params: {} }),
      () => ({ id: `id-${"x".repeat(256)}`, method: "fixture/event", params: {} }),
      () => ({ method: "fixture/event", params: {}, emittedAtMs: -1 }),
      id => ({ id, method: "fixture/request", params: {}, emittedAtMs: 1770000000000 }),
      id => ({ id, method: "fixture/event", params: {}, result: {} }),
    ];
    for (const makeFrame of frames) {
      const h = harness();
      const transport = new MsbStdioTransport("codex-demo", h.spawn, { shutdownGraceMs: 5 });
      const pending = transport.request("fixture/wait", {});
      const request = await outbound(h);
      h.stdout.enqueue(`${JSON.stringify(makeFrame(request.id))}\n`);
      await expect(pending).rejects.toThrow("rpc_protocol_error");
      await transport.close();
    }
  });
});

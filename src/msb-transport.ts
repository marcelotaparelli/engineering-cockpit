import { assertArchHost } from "./host.ts";
import { randomUUID } from "node:crypto";
import { SafeError, vmIdentity } from "./model.ts";
import { encodeJsonl, JsonlObjectParser, type JsonObject } from "./jsonl.ts";
import type { RpcId, RpcInboundMessage, RpcTransport } from "./provider.ts";

export interface MsbChildStdin {
  write(data: Uint8Array): number | Promise<number>;
  end(): void | Promise<void>;
}

export interface MsbChild {
  stdin: MsbChildStdin;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal: "SIGKILL"): void;
  /** Host PID when the child is a real process (E4 process ledger); absent for in-process doubles. */
  pid?: number;
}

export interface MsbSpawnOptions {
  stdin: "pipe";
  stdout: "pipe";
  stderr: "pipe";
  env: Record<string, string>;
}
export type MsbSpawn = (argv: readonly string[], options: MsbSpawnOptions) => MsbChild;

export interface MsbTransportOptions {
  requestDeadlineMs?: number;
  maxFrameBytes?: number;
  maxBufferBytes?: number;
  maxStderrBytes?: number;
  shutdownGraceMs?: number;
  maxInboundMessages?: number;
  env?: Readonly<Record<string, string | undefined>>;
}

export function msbStreamArgv(vmName: string): readonly string[] {
  const identity = vmIdentity(vmName);
  if (identity.provider !== "codex") throw new SafeError("invalid_transport_target");
  return Object.freeze(["msb", "exec", "--stream", vmName, "--", "codex", "app-server", "--listen", "stdio://"]);
}

export function minimalChildEnv(source: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ["PATH", "LANG", "LC_ALL"] as const) {
    const value = source[name];
    if (value && !value.includes("\0")) result[name] = value;
  }
  return result;
}

/** The only real spawn of `msb` children (Codex and Claude): Arch host check, argv array, no shell. */
export const hostSpawn: MsbSpawn = (argv, options) => {
  assertArchHost();
  return Bun.spawn([...argv], options) as unknown as MsbChild;
};
const nativeSpawn = hostSpawn;

class InboundQueue implements AsyncIterable<RpcInboundMessage> {
  #values: RpcInboundMessage[] = [];
  #waiters: Array<{ resolve: (value: IteratorResult<RpcInboundMessage>) => void; reject: (error: SafeError) => void }> = [];
  #ended = false;
  #error: SafeError | undefined;

  constructor(readonly maxMessages: number) {}

  push(value: RpcInboundMessage): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else {
      if (this.#values.length >= this.maxMessages) throw new SafeError("rpc_inbound_queue_limit");
      this.#values.push(value);
    }
  }
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }
  fail(error: SafeError): void {
    if (this.#ended) return;
    this.#error = error;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
  [Symbol.asyncIterator](): AsyncIterator<RpcInboundMessage> {
    return { next: async () => {
      const value = this.#values.shift();
      if (value) return { value, done: false };
      if (this.#error) throw this.#error;
      if (this.#ended) return { value: undefined, done: true };
      return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
    } };
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: SafeError): void;
  timer: ReturnType<typeof setTimeout>;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function rpcId(value: unknown): value is RpcId {
  return (typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0")) ||
    (typeof value === "number" && Number.isSafeInteger(value));
}
function onlyKeys(value: JsonObject, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

export class MsbStdioTransport implements RpcTransport {
  readonly #child: MsbChild;
  readonly #parser: JsonlObjectParser;
  readonly #queue: InboundQueue;
  readonly #pending = new Map<RpcId, Pending>();
  readonly #settled = new Set<RpcId>();
  readonly #requestDeadlineMs: number;
  readonly #maxFrameBytes: number;
  readonly #maxStderrBytes: number;
  readonly #shutdownGraceMs: number;
  #stdoutReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  #stderrReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  readonly #generation = randomUUID();
  #nextId = 1;
  #closed = false;
  #exitSettled = false;
  #cleanupPromise: Promise<void> | undefined;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(vmName: string, spawn: MsbSpawn = nativeSpawn, options: MsbTransportOptions = {}) {
    const argv = msbStreamArgv(vmName);
    this.#requestDeadlineMs = options.requestDeadlineMs ?? 10_000;
    this.#maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
    this.#shutdownGraceMs = options.shutdownGraceMs ?? 50;
    const maxInboundMessages = options.maxInboundMessages ?? 1024;
    if (![this.#requestDeadlineMs, this.#maxStderrBytes, this.#shutdownGraceMs, maxInboundMessages].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new SafeError("invalid_transport_limits");
    }
    this.#queue = new InboundQueue(maxInboundMessages);
    this.#parser = new JsonlObjectParser(options.maxFrameBytes, options.maxBufferBytes);
    this.#maxFrameBytes = this.#parser.maxFrameBytes;
    try {
      this.#child = spawn(argv, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: minimalChildEnv(options.env),
      });
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError("msb_spawn_failed");
    }
    void this.#readStdout();
    void this.#readStderr();
    void this.#observeExit();
  }

  request(method: string, params: Record<string, unknown>, deadlineMs = this.#requestDeadlineMs): Promise<unknown> {
    this.#validateOutbound(method, params);
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) return Promise.reject(new SafeError("invalid_request_deadline"));
    if (this.#closed) return Promise.reject(new SafeError("transport_closed"));
    const id = `${this.#generation}:${this.#nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        this.#rememberSettled(id);
        pending.reject(new SafeError("rpc_deadline_exceeded"));
      }, deadlineMs);
      this.#pending.set(id, { resolve, reject, timer });
      void this.#write({ id, method, params }).catch(error => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        this.#rememberSettled(id);
        pending.reject(error instanceof SafeError ? error : new SafeError("transport_write_failed"));
      });
    });
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    this.#validateOutbound(method, params);
    await this.#writeBounded({ method, ...(params === undefined ? {} : { params }) });
  }

  async respond(id: RpcId, result: unknown): Promise<void> {
    if (!rpcId(id)) throw new SafeError("rpc_invalid_id");
    await this.#writeBounded({ id, result });
  }

  messages(): AsyncIterable<RpcInboundMessage> { return this.#queue; }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#rejectPending(new SafeError("transport_closed"));
      this.#queue.end();
    }
    await this.#cleanup();
  }

  #validateOutbound(method: string, params?: Record<string, unknown>): void {
    if (!method || method.length > 128 || (params !== undefined && !object(params))) throw new SafeError("rpc_invalid_request");
  }

  async #write(frame: JsonObject): Promise<void> {
    if (this.#closed) throw new SafeError("transport_closed");
    const bytes = encodeJsonl(frame);
    if (bytes.byteLength > this.#maxFrameBytes) throw new SafeError("rpc_frame_limit");
    const write = this.#writeChain.then(async () => { await this.#child.stdin.write(bytes); });
    this.#writeChain = write.catch(() => {});
    try { await write; }
    catch {
      this.#fail(new SafeError("transport_write_failed"));
      throw new SafeError("transport_write_failed");
    }
  }

  async #writeBounded(frame: JsonObject): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SafeError("rpc_deadline_exceeded")), this.#requestDeadlineMs);
    });
    try { await Promise.race([this.#write(frame), deadline]); }
    catch (error) {
      const safe = error instanceof SafeError ? error : new SafeError("transport_write_failed");
      this.#fail(safe);
      throw safe;
    } finally { if (timer) clearTimeout(timer); }
  }

  async #readStdout(): Promise<void> {
    const reader = this.#child.stdout.getReader();
    this.#stdoutReader = reader;
    try {
      while (!this.#closed) {
        const chunk = await reader.read();
        if (chunk.done) {
          this.#parser.finish();
          if (!this.#closed) this.#fail(new SafeError("transport_eof"));
          return;
        }
        for (const frame of this.#parser.push(chunk.value)) this.#handleFrame(frame);
      }
    } catch (error) {
      if (!this.#closed) this.#fail(error instanceof SafeError ? error : new SafeError("transport_read_failed"));
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
      if (this.#stdoutReader === reader) this.#stdoutReader = undefined;
    }
  }

  async #readStderr(): Promise<void> {
    const reader = this.#child.stderr.getReader();
    this.#stderrReader = reader;
    let bytes = 0;
    try {
      while (!this.#closed) {
        const chunk = await reader.read();
        if (chunk.done) return;
        bytes += chunk.value.byteLength;
        if (bytes > this.#maxStderrBytes) throw new SafeError("msb_stderr_limit");
      }
    } catch (error) {
      if (!this.#closed) this.#fail(error instanceof SafeError ? error : new SafeError("transport_stderr_failed"));
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
      if (this.#stderrReader === reader) this.#stderrReader = undefined;
    }
  }

  async #observeExit(): Promise<void> {
    let code: number;
    try { code = await this.#child.exited; }
    catch {
      this.#exitSettled = true;
      if (!this.#closed) this.#fail(new SafeError("msb_exit_failed"));
      return;
    }
    this.#exitSettled = true;
    if (!this.#closed) this.#fail(new SafeError(code === 0 ? "transport_eof" : "msb_exit_failed"));
  }

  #handleFrame(frame: JsonObject): void {
    // Codex app-server 0.163.0 uses JSONL RPC envelopes without a JSON-RPC
    // version member. Rejecting it is intentional: accepting both profiles
    // would hide protocol drift in the version-pinned adapter.
    if (Object.hasOwn(frame, "jsonrpc")) return this.#fail(new SafeError("rpc_protocol_error"));
    const hasId = Object.hasOwn(frame, "id");
    const hasMethod = Object.hasOwn(frame, "method");
    if (hasMethod) {
      const hasEmittedAt = Object.hasOwn(frame, "emittedAtMs");
      if (typeof frame.method !== "string" || frame.method.length === 0 || frame.method.length > 128 ||
        Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error") ||
        !onlyKeys(frame, hasId ? ["id", "method", "params"] : ["method", "params", "emittedAtMs"]) ||
        (hasEmittedAt && (!Number.isSafeInteger(frame.emittedAtMs) || (frame.emittedAtMs as number) < 0)) ||
        (Object.hasOwn(frame, "params") && !object(frame.params)) || (hasId && !rpcId(frame.id))) {
        return this.#fail(new SafeError("rpc_protocol_error"));
      }
      const message: RpcInboundMessage = { method: frame.method, params: object(frame.params) ? frame.params : {} };
      if (hasId) message.requestId = frame.id as RpcId;
      this.#queue.push(message);
      return;
    }
    if (!hasId || !rpcId(frame.id)) return this.#fail(new SafeError("rpc_protocol_error"));
    const hasResult = Object.hasOwn(frame, "result");
    const hasError = Object.hasOwn(frame, "error");
    if (hasResult === hasError || !onlyKeys(frame, ["id", hasResult ? "result" : "error"])) {
      return this.#fail(new SafeError("rpc_protocol_error"));
    }
    if (hasError) {
      const error = frame.error;
      if (!object(error) || !Number.isSafeInteger(error.code) || typeof error.message !== "string" ||
        error.message.length === 0 || error.message.length > 512 || !onlyKeys(error, ["code", "message", "data"])) {
        return this.#fail(new SafeError("rpc_protocol_error"));
      }
    }
    const id = frame.id;
    const pending = this.#pending.get(id);
    if (!pending) return this.#fail(new SafeError(this.#settled.has(id) ? "rpc_duplicate_response" : "rpc_unknown_response"));
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    this.#rememberSettled(id);
    if (hasError) pending.reject(new SafeError("provider_request_failed"));
    else pending.resolve(frame.result);
  }

  #fail(error: SafeError): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(error);
    this.#queue.fail(error);
    void this.#cleanup();
  }

  #rejectPending(error: SafeError): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#rememberSettled(id);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #cleanup(): Promise<void> {
    if (this.#cleanupPromise) return this.#cleanupPromise;
    this.#cleanupPromise = (async () => {
      const shutdown: Promise<unknown>[] = [];
      if (this.#stdoutReader) shutdown.push(this.#stdoutReader.cancel().catch(() => {}));
      if (this.#stderrReader) shutdown.push(this.#stderrReader.cancel().catch(() => {}));
      shutdown.push(Promise.resolve(this.#child.stdin.end()).catch(() => {}));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), this.#shutdownGraceMs); });
      const exitedAndShutdown = Promise.all([this.#child.exited.catch(() => -1), ...shutdown]).then(() => "exited" as const);
      const outcome = await Promise.race([exitedAndShutdown, grace]);
      if (timer) clearTimeout(timer);
      if (outcome === "timeout" && !this.#exitSettled) {
        try { this.#child.kill("SIGKILL"); } catch { /* owned child already exited */ }
        let reapTimer: ReturnType<typeof setTimeout> | undefined;
        const boundedReap = new Promise<void>(resolve => { reapTimer = setTimeout(resolve, this.#shutdownGraceMs); });
        await Promise.race([this.#child.exited.then(() => {}, () => {}), boundedReap]);
        if (reapTimer) clearTimeout(reapTimer);
      }
    })();
    return this.#cleanupPromise;
  }

  #rememberSettled(id: RpcId): void {
    this.#settled.add(id);
    if (this.#settled.size > 4096) {
      const oldest = this.#settled.values().next().value;
      if (oldest !== undefined) this.#settled.delete(oldest);
    }
  }
}

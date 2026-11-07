import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore } from "../src/runtime-store.ts";
import { EventHub } from "../src/event-hub.ts";
import { ExecutionService } from "../src/execution.ts";
import { CodexAppServerAdapter } from "../src/codex-adapter.ts";
import type { RpcInboundMessage, RpcTransport } from "../src/provider.ts";

/** Scripted App Server: a foreign turn completes while our turn/start is still in flight. */
class Scripted implements RpcTransport {
  queue: RpcInboundMessage[] = [];
  waiters: Array<(value: IteratorResult<RpcInboundMessage>) => void> = [];
  emit(method: string, params: Record<string, unknown>, requestId?: string) {
    const message = { method, params, ...(requestId ? { requestId } : {}) };
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false }); else this.queue.push(message);
  }
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "initialize") return { userAgent: "engineering-cockpit/0.164.0 (x)", codexHome: "/h", platformFamily: "unix", platformOs: "linux" };
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: "thread-1" } };
    if (method === "turn/start") {
      // Foreign turn on the same thread finishes, and a foreign approval arrives, before our response.
      this.emit("turn/completed", { threadId: "thread-1", turn: { id: "foreign-turn", status: "completed" } });
      this.emit("item/commandExecution/requestApproval", { threadId: "thread-1", turnId: "foreign-turn", itemId: "x", command: "rm -rf /" }, "req-foreign");
      this.emit("item/commandExecution/requestApproval", { threadId: "thread-1", turnId: "foreign-turn", itemId: "x", command: "dup" }, "req-foreign");
      this.emit("turn/started", { threadId: "thread-1", turn: { id: "own-turn", status: "inProgress" } });
      await Bun.sleep(5);
      return { turn: { id: "own-turn" } };
    }
    return {};
  }
  async notify() {}
  async respond() {}
  messages(): AsyncIterable<RpcInboundMessage> {
    return { [Symbol.asyncIterator]: () => ({ next: async () => {
      const value = this.queue.shift();
      if (value) return { value, done: false };
      return new Promise(resolve => this.waiters.push(resolve));
    } }) };
  }
  async close() { for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true }); }
}

test("events of another turn are never attributed to a run whose turn id is not yet known; bad frames do not drop the VM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cockpit-binding-"));
  const store = new RuntimeStore(join(dir, "rt", "runtime.sqlite"));
  const transport = new Scripted();
  const snapshot = { source: "mock" as const, host_verification: "not_verified" as const, observed_at: new Date().toISOString(), projects: ["alpha"],
    vms: [{ vm_name: "codex-alpha", project: "alpha", provider: "codex" as const, state: "running" as const, orphaned: false }] };
  const service = new ExecutionService({ store, adapter: new CodexAppServerAdapter(() => transport), hub: new EventHub(), refresh: async () => snapshot, log: () => {} });
  try {
    const target = await service.revalidate("codex-alpha");
    const session = await service.openSession(target, "new");
    const { run } = await service.startRun(session, "ola", "key-binding-0123456789");
    await Bun.sleep(40);
    const current = store.getRun(run.runId)!;
    expect(current.status).toBe("running");
    expect(current.providerRunId).toBe("own-turn");
    expect(store.pendingApprovals()).toEqual([]);
    transport.emit("turn/completed", { threadId: "thread-1", turn: { id: "own-turn", status: "completed" } });
    await Bun.sleep(20);
    expect(store.getRun(run.runId)!.status).toBe("completed");
  } finally { await service.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

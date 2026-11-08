import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore } from "../../src/runtime-store.ts";
import { EventHub } from "../../src/event-hub.ts";
import { ExecutionService, type ExecutionLog, type ExecutionOptions } from "../../src/execution.ts";
import { ClaudeCodeAdapter } from "../../src/claude-adapter.ts";
import { newFakeWorld } from "../../src/fake-claude.ts";
import type { Snapshot } from "../../src/model.ts";
import { scriptedClaude, type ScriptedProcess, type ScriptedTurn } from "./scripted-claude.ts";

/**
 * E4 harness: the real ExecutionService/RuntimeStore/ClaudeCodeAdapter with a scripted Claude CLI whose frames (and pauses,
 * and deaths) are decided by the test, and a discovery whose VM state the test controls. No VM, no quota, no real prompt.
 */
export interface Harness {
  dir: string; path: string; store: RuntimeStore; execution: ExecutionService; logs: ExecutionLog[];
  vm: { state: "running" | "stopped"; present: boolean; refreshFails: boolean };
  turns: ScriptedTurn[]; processes: ScriptedProcess[]; nextTurn(): Promise<ScriptedTurn>;
}
const open: Harness[] = [];
/** Call from `afterEach`. */
export async function closeHarnesses(): Promise<void> {
  for (const h of open.splice(0)) {
    await h.execution.close().catch(() => {});
    try { h.store.close(); } catch { /* closed by the test */ }
    await rm(h.dir, { recursive: true, force: true });
  }
}

export async function harness(options: { partialFlushMs?: number; processes?: (store: RuntimeStore) => NonNullable<ExecutionOptions["processes"]>; approvalTtlMs?: number } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "cockpit-e4-"));
  const path = join(dir, "runtime", "runtime.sqlite");
  const store = new RuntimeStore(path);
  const vm = { state: "running" as "running" | "stopped", present: true, refreshFails: false };
  const turns: ScriptedTurn[] = [];
  const waiters: Array<(turn: ScriptedTurn) => void> = [];
  const { spawn, processes } = scriptedClaude(newFakeWorld(), turn => { const waiter = waiters.shift(); if (waiter) waiter(turn); else turns.push(turn); });
  const logs: ExecutionLog[] = [];
  const snapshot = async (): Promise<Snapshot> => {
    if (vm.refreshFails) throw new Error("msb list failed");
    return { source: "mock", host_verification: "not_verified", observed_at: new Date().toISOString(), projects: ["alpha"],
      vms: vm.present ? [{ vm_name: "claude-alpha", project: "alpha", provider: "claude", state: vm.state, orphaned: false }] : [] };
  };
  const execution = new ExecutionService({ store, adapters: [new ClaudeCodeAdapter({ spawn, closeGraceMs: 50, idleMs: 60_000 })], hub: new EventHub(),
    refresh: snapshot, log: entry => { logs.push(entry); }, partialFlushMs: options.partialFlushMs ?? 100,
    ...(options.processes ? { processes: options.processes(store) } : {}), ...(options.approvalTtlMs ? { approvalTtlMs: options.approvalTtlMs } : {}) });
  const h: Harness = { dir, path, store, execution, logs, vm, turns, processes,
    nextTurn: () => turns.length ? Promise.resolve(turns.shift()!) : new Promise(resolve => waiters.push(resolve)) };
  open.push(h);
  return h;
}
export async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timeout; last=${JSON.stringify(value)}`);
    await Bun.sleep(5);
  }
}
export async function startTurn(h: Harness, prompt = "escreva") {
  const target = await h.execution.revalidate("claude-alpha", "alpha");
  const session = await h.execution.openSession(target, "new");
  const { run } = await h.execution.startRun(session, prompt, `key-${crypto.randomUUID()}`);
  const turn = await h.nextTurn();
  await until(() => h.store.getRun(run.runId)!.status, status => status === "running");
  return { session, run, turn };
}
export const agentItems = (store: RuntimeStore, sessionId: string) => store.transcriptPage(sessionId).items.filter(item => item.kind === "agent_message");


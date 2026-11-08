import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore } from "../src/runtime-store.ts";
import { EventHub } from "../src/event-hub.ts";
import { ExecutionService, type ExecutionLog } from "../src/execution.ts";
import { ClaudeCodeAdapter } from "../src/claude-adapter.ts";
import { newFakeWorld } from "../src/fake-claude.ts";
import type { Snapshot } from "../src/model.ts";
import { scriptedClaude, type ScriptedProcess, type ScriptedTurn } from "./support/scripted-claude.ts";

/**
 * E4 — deterministic recovery scenarios over the real ExecutionService/RuntimeStore/ClaudeCodeAdapter, with a scripted
 * Claude CLI whose frames (and pauses, and deaths) are decided by the test. No VM, no quota, no real prompt.
 */
interface Harness {
  dir: string; path: string; store: RuntimeStore; execution: ExecutionService; logs: ExecutionLog[];
  vm: { state: "running" | "stopped"; present: boolean; refreshFails: boolean };
  turns: ScriptedTurn[]; processes: ScriptedProcess[]; nextTurn(): Promise<ScriptedTurn>;
}
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) {
    await h.execution.close().catch(() => {});
    try { h.store.close(); } catch { /* closed by the test */ }
    await rm(h.dir, { recursive: true, force: true });
  }
});

async function harness(options: { partialFlushMs?: number } = {}): Promise<Harness> {
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
    refresh: snapshot, log: entry => { logs.push(entry); }, partialFlushMs: options.partialFlushMs ?? 100 });
  const h: Harness = { dir, path, store, execution, logs, vm, turns, processes,
    nextTurn: () => turns.length ? Promise.resolve(turns.shift()!) : new Promise(resolve => waiters.push(resolve)) };
  open.push(h);
  return h;
}
async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timeout; last=${JSON.stringify(value)}`);
    await Bun.sleep(5);
  }
}
async function startTurn(h: Harness, prompt = "escreva") {
  const target = await h.execution.revalidate("claude-alpha", "alpha");
  const session = await h.execution.openSession(target, "new");
  const { run } = await h.execution.startRun(session, prompt, `key-${crypto.randomUUID()}`);
  const turn = await h.nextTurn();
  await until(() => h.store.getRun(run.runId)!.status, status => status === "running");
  return { session, run, turn };
}
const agentItems = (store: RuntimeStore, sessionId: string) => store.transcriptPage(sessionId).items.filter(item => item.kind === "agent_message");

describe("E4: partial responses are durable while the stream pauses", () => {
  test("the tail streamed just before a pause is persisted without waiting for another delta", async () => {
    const h = await harness({ partialFlushMs: 100 });
    const { session, turn } = await startTurn(h);
    turn.messageStart("msg_1");
    turn.text("Primeira parte. "); // first chunk: written at once
    await until(() => agentItems(h.store, session.sessionId), items => items.length === 1);
    turn.text("Cauda antes da pausa."); // inside the interval: before E4 this stayed in memory until the next delta
    // No further frame: the agent is "thinking" or waiting on a tool. The trailing write must land on its own.
    const items = await until(() => agentItems(h.store, session.sessionId), list => list[0]?.text === "Primeira parte. Cauda antes da pausa.", 1000);
    expect(items[0]).toMatchObject({ status: "in_progress" });
    expect(items[0]!.incomplete).toBeUndefined(); // the run is still active: in progress, not incomplete
  });

  test("abrupt end of the Cockpit (no orderly close): the restarted store shows the full streamed text as incomplete, run unknown", async () => {
    const h = await harness({ partialFlushMs: 50 });
    const { session, run, turn } = await startTurn(h);
    turn.messageStart("msg_1");
    for (const word of ["um ", "dois ", "três ", "quatro"]) turn.text(word);
    await until(() => agentItems(h.store, session.sessionId), list => list[0]?.text === "um dois três quatro", 1000);
    // "kill -9": nothing is flushed or closed; a new process opens the same file (same PID here, so the ownership probe allows it).
    const restarted = new RuntimeStore(h.path);
    try {
      expect(restarted.getRun(run.runId)).toMatchObject({ status: "unknown", reasonCode: "process_restarted" });
      const [item] = agentItems(restarted, session.sessionId);
      expect(item).toMatchObject({ text: "um dois três quatro", incomplete: true });
      // The prompt is there once; nothing was resent.
      expect(restarted.transcriptPage(session.sessionId).items.filter(entry => entry.kind === "user_message")).toHaveLength(1);
      expect(h.processes.flatMap(process => process.controlFrames)).toEqual([]);
    } finally { restarted.close(); }
  });

  test("the trailing write never resurrects a partial after the final message or after the run ended", async () => {
    const h = await harness({ partialFlushMs: 60 });
    const { session, run, turn } = await startTurn(h);
    turn.messageStart("msg_1");
    turn.text("rascunho ");
    turn.text("mais");
    turn.assistantText("msg_1", "versão final");
    turn.result(true);
    await until(() => h.store.getRun(run.runId)!.status, status => status === "completed");
    await Bun.sleep(150); // past any pending trailing write
    const [item] = agentItems(h.store, session.sessionId);
    expect(item).toMatchObject({ text: "versão final", status: "completed" });
    expect(item!.incomplete).toBeUndefined();
  });
});

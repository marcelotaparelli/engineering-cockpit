import { randomUUID } from "node:crypto";
import type { RpcId, RpcInboundMessage, RpcTransport } from "./provider.ts";

/**
 * Deterministic in-process stand-in for `codex app-server` used ONLY in mock mode and tests.
 * It speaks the same JSONL-RPC shapes the adapter expects (0.164-style). Nothing is executed.
 * Prompt keywords drive scenarios: "aprova"/"approval" → command approval; "falha"/"fail" → failed turn;
 * "lento"/"slow" → slow stream (useful to try interrupt).
 */
interface FakeItem { type: string; id: string; [key: string]: unknown }
interface FakeTurn { id: string; status: "inProgress" | "completed" | "failed" | "interrupted"; items: FakeItem[] }
interface FakeThread { id: string; updatedAt: number; turns: FakeTurn[] }

export class FakeCodexWorld {
  readonly threads = new Map<string, FakeThread>();
  turnStarts = 0;
}

const worlds = new Map<string, FakeCodexWorld>();
export function fakeWorld(vmName: string): FakeCodexWorld {
  let world = worlds.get(vmName);
  if (!world) { world = new FakeCodexWorld(); worlds.set(vmName, world); }
  return world;
}

class Queue implements AsyncIterable<RpcInboundMessage> {
  #values: RpcInboundMessage[] = [];
  #waiters: Array<(value: IteratorResult<RpcInboundMessage>) => void> = [];
  #ended = false;
  push(value: RpcInboundMessage): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false }); else this.#values.push(value);
  }
  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<RpcInboundMessage> {
    return { next: async () => {
      const value = this.#values.shift();
      if (value) return { value, done: false };
      if (this.#ended) return { value: undefined, done: true };
      return new Promise(resolve => this.#waiters.push(resolve));
    } };
  }
}

export interface FakeCodexOptions { delayMs?: number; version?: string }

export class FakeCodexTransport implements RpcTransport {
  readonly #queue = new Queue();
  readonly #delayMs: number;
  readonly #version: string;
  readonly #approvals = new Map<RpcId, (decision: string) => void>();
  readonly #interrupts = new Map<string, () => void>();
  #closed = false;
  #nextRequest = 1;

  constructor(readonly world: FakeCodexWorld, options: FakeCodexOptions = {}) {
    this.#delayMs = options.delayMs ?? 35;
    this.#version = options.version ?? "0.164.0";
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) throw new Error("closed");
    switch (method) {
      case "initialize":
        return { userAgent: `engineering-cockpit/${this.#version} (fake-codex; simulation)`, codexHome: "/simulated/codex-home", platformFamily: "unix", platformOs: "linux" };
      case "thread/list":
        return { data: [...this.world.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Number(params.limit ?? 25))
          .map(thread => ({ id: thread.id, status: { type: "idle" }, updatedAt: thread.updatedAt })), nextCursor: null };
      case "thread/start": {
        const thread: FakeThread = { id: randomUUID(), updatedAt: Math.floor(Date.now() / 1000), turns: [] };
        this.world.threads.set(thread.id, thread);
        queueMicrotask(() => this.#emit("thread/started", { thread: { id: thread.id } }));
        return { thread: { id: thread.id } };
      }
      case "thread/resume": {
        const thread = this.world.threads.get(String(params.threadId));
        if (!thread) throw new Error("thread not found");
        return { thread: { id: thread.id } };
      }
      case "thread/read": {
        const thread = this.world.threads.get(String(params.threadId));
        if (!thread) throw new Error("thread not found");
        return { thread: { id: thread.id, turns: thread.turns.map(turn => ({ id: turn.id, status: turn.status, items: turn.items })) } };
      }
      case "turn/start": {
        const thread = this.world.threads.get(String(params.threadId));
        if (!thread) throw new Error("thread not found");
        const input = Array.isArray(params.input) ? params.input[0] as { text?: unknown } : undefined;
        const prompt = typeof input?.text === "string" ? input.text : "";
        const turn: FakeTurn = { id: randomUUID(), status: "inProgress", items: [] };
        thread.turns.push(turn);
        thread.updatedAt = Math.floor(Date.now() / 1000);
        this.world.turnStarts++;
        void this.#simulate(thread, turn, prompt);
        return { turn: { id: turn.id, status: "inProgress", items: [] } };
      }
      case "turn/interrupt": {
        this.#interrupts.get(String(params.turnId))?.();
        return {};
      }
      default:
        throw new Error("unsupported fake method");
    }
  }

  async notify(): Promise<void> {}

  async respond(id: RpcId, result: unknown): Promise<void> {
    const resolve = this.#approvals.get(id);
    if (!resolve) return;
    this.#approvals.delete(id);
    const decision = typeof result === "object" && result !== null && "decision" in result ? String((result as { decision: unknown }).decision) : "decline";
    resolve(decision);
  }

  messages(): AsyncIterable<RpcInboundMessage> { return this.#queue; }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const interrupt of this.#interrupts.values()) interrupt();
    this.#queue.end();
  }

  /** Test hook: simulate the `msb exec` child dying mid-turn. */
  crash(): void { this.#closed = true; this.#queue.end(); }

  #emit(method: string, params: Record<string, unknown>, requestId?: RpcId): void {
    if (this.#closed) return;
    this.#queue.push({ method, params, ...(requestId === undefined ? {} : { requestId }) });
  }

  async #simulate(thread: FakeThread, turn: FakeTurn, prompt: string): Promise<void> {
    let interrupted = false;
    let wake: (() => void) | undefined;
    this.#interrupts.set(turn.id, () => { interrupted = true; wake?.(); });
    const lower = prompt.toLowerCase();
    const slow = lower.includes("lento") || lower.includes("slow");
    const pause = (factor = 1) => new Promise<void>(resolve => {
      const timer = setTimeout(resolve, this.#delayMs * factor * (slow ? 8 : 1));
      wake = () => { clearTimeout(timer); resolve(); };
    });
    const base = { threadId: thread.id, turnId: turn.id };
    const finish = (status: FakeTurn["status"], message?: string) => {
      turn.status = status;
      this.#interrupts.delete(turn.id);
      this.#emit("turn/completed", { threadId: thread.id, turn: { id: turn.id, status, items: [], error: message ? { message } : null } });
    };
    await pause(0.2);
    this.#emit("turn/started", { threadId: thread.id, turn: { id: turn.id, status: "inProgress", items: [] } });
    const user: FakeItem = { type: "userMessage", id: randomUUID(), clientId: null, content: [{ type: "text", text: prompt, text_elements: [] }] };
    turn.items.push(user);
    this.#emit("item/completed", { ...base, item: user, completedAtMs: Date.now() });

    if (lower.includes("aprova") || lower.includes("approval")) {
      const command: FakeItem = { type: "commandExecution", id: randomUUID(), command: "bun test", cwd: "/workspace", status: "inProgress", aggregatedOutput: null, exitCode: null };
      this.#emit("item/started", { ...base, item: command, startedAtMs: Date.now() });
      const requestId = `fake-approval-${this.#nextRequest++}`;
      const decision = await new Promise<string>(resolve => {
        this.#approvals.set(requestId, resolve);
        wake = () => { this.#approvals.delete(requestId); resolve("interrupted"); };
        this.#emit("item/commandExecution/requestApproval", { ...base, itemId: command.id, command: "bun test", cwd: "/workspace",
          reason: "Simulação: o agente quer rodar a suíte de testes.", startedAtMs: Date.now() }, requestId);
      });
      if (decision === "interrupted" || interrupted) {
        this.#emit("serverRequest/resolved", { threadId: thread.id, requestId });
        return finish("interrupted");
      }
      const accepted = decision === "accept";
      Object.assign(command, accepted ? { status: "completed", exitCode: 0, aggregatedOutput: "12 pass, 0 fail (simulado)" } : { status: "declined" });
      turn.items.push(command);
      this.#emit("item/completed", { ...base, item: command, completedAtMs: Date.now() });
    }

    const structured = lower.includes("quota") ? "usageLimitExceeded" : lower.includes("unauthorized") ? "unauthorized" : null;
    if (structured) {
      await pause();
      const error = { message: "Simulação: erro estruturado do provider (sk-SECRET-should-never-be-persisted)", codexErrorInfo: structured };
      this.#emit("error", { ...base, error, willRetry: false });
      turn.status = "failed";
      this.#interrupts.delete(turn.id);
      return this.#emit("turn/completed", { threadId: thread.id, turn: { id: turn.id, status: "failed", items: [], error } });
    }
    if (lower.includes("falha") || lower.includes("fail")) {
      await pause();
      return finish("failed", "Simulação: o modelo retornou erro.");
    }

    const reply = `Simulação do Codex (modo mock). Recebi: "${prompt.slice(0, 120)}". Nenhum comando real foi executado; este texto é transmitido em partes para demonstrar o streaming.`;
    const agent: FakeItem = { type: "agentMessage", id: randomUUID(), text: "", phase: null };
    this.#emit("item/started", { ...base, item: agent, startedAtMs: Date.now() });
    for (const word of reply.split(/(?<= )/)) {
      if (interrupted) break;
      await pause();
      if (interrupted) break;
      agent.text = String(agent.text) + word;
      this.#emit("item/agentMessage/delta", { ...base, itemId: agent.id, delta: word });
    }
    turn.items.push(agent);
    this.#emit("item/completed", { ...base, item: agent, completedAtMs: Date.now() });
    if (interrupted) return finish("interrupted");
    finish("completed");
  }
}

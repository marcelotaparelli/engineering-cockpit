import { SafeError } from "./model.ts";
import { encodeJsonl, JsonlObjectParser, type JsonObject } from "./jsonl.ts";
import { minimalChildEnv, type MsbChild, type MsbSpawn } from "./msb-transport.ts";
import { claudeExecArgv, parseClaudeEvent, type ClaudeEvent } from "./claude-protocol.ts";

export interface ExitReport { exited: boolean; killed: boolean; code: number | null }

/**
 * E2 spike driver: one `claude -p --input-format stream-json` child, many turns over its stdin.
 * Pull-based event queue, stderr drained and discarded (only its size is kept), bounded frames,
 * orderly shutdown (close stdin → grace → SIGKILL) with an explicit report of how the process ended.
 */
export class ClaudeStreamProcess {
  readonly #child: MsbChild;
  readonly #parser = new JsonlObjectParser(4 * 1024 * 1024, 8 * 1024 * 1024);
  readonly #events: ClaudeEvent[] = [];
  #waiter: (() => void) | null = null;
  #ended = false;
  #error: SafeError | null = null;
  #exitCode: number | null = null;
  #writes: Promise<unknown> = Promise.resolve();
  stderrBytes = 0;
  readonly #maxQueued: number;

  /** `maxQueued`: unconsumed events beyond this kill the child (a stalled consumer must not grow memory without bound). */
  constructor(child: MsbChild, maxQueued = 20_000) {
    this.#maxQueued = maxQueued;
    this.#child = child;
    void this.#readStdout();
    void this.#drainStderr();
    void child.exited.then(code => { this.#exitCode = code; this.#end(); }, () => this.#end());
  }

  get exitCode(): number | null { return this.#exitCode; }
  get error(): SafeError | null { return this.#error; }

  send(frame: JsonObject): Promise<void> {
    if (this.#ended) return Promise.reject(new SafeError("claude_process_ended"));
    const bytes = encodeJsonl(frame);
    const write = this.#writes.then(async () => { await this.#child.stdin.write(bytes); });
    this.#writes = write.catch(() => {});
    return write.catch(() => { throw new SafeError("claude_write_failed"); });
  }

  /** Next event, or null when the process ended / the deadline passed (check `ended`). */
  async next(timeoutMs: number): Promise<ClaudeEvent | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const event = this.#events.shift();
      if (event) return event;
      if (this.#ended) return null;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.#waiter = null; resolve(); }, left);
        this.#waiter = () => { clearTimeout(timer); this.#waiter = null; resolve(); };
      });
    }
  }
  get ended(): boolean { return this.#ended; }

  /** Collect events until `until` is satisfied (inclusive), the process ends or the deadline passes. */
  async collect(until: (event: ClaudeEvent) => boolean, timeoutMs: number): Promise<{ events: ClaudeEvent[]; matched: boolean }> {
    const events: ClaudeEvent[] = [];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const event = await this.next(Math.max(0, deadline - Date.now()));
      if (!event) return { events, matched: false };
      events.push(event);
      if (until(event)) return { events, matched: true };
    }
  }

  async close(graceMs = 2000): Promise<ExitReport> {
    try { await this.#child.stdin.end(); } catch { /* already closed */ }
    if (await this.#waitExit(graceMs)) return { exited: true, killed: false, code: this.#exitCode };
    try { this.#child.kill("SIGKILL"); } catch { /* gone */ }
    const exited = await this.#waitExit(graceMs);
    return { exited, killed: true, code: this.#exitCode };
  }

  async #waitExit(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      this.#child.exited.then(() => true, () => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
    if (timer) clearTimeout(timer);
    return outcome;
  }

  #push(event: ClaudeEvent): void {
    if (this.#events.length >= this.#maxQueued) throw new SafeError("claude_event_queue_limit");
    this.#events.push(event); this.#waiter?.();
  }
  #end(): void { this.#ended = true; this.#waiter?.(); }

  async #readStdout(): Promise<void> {
    const reader = this.#child.stdout.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) { this.#parser.finish(); return; }
        for (const frame of this.#parser.push(chunk.value)) this.#push(parseClaudeEvent(frame));
      }
    } catch (error) {
      this.#error = error instanceof SafeError ? error : new SafeError("claude_read_failed");
      try { this.#child.kill("SIGKILL"); } catch { /* gone */ }
    } finally { this.#end(); }
  }

  async #drainStderr(): Promise<void> {
    const reader = this.#child.stderr.getReader();
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) return; this.stderrBytes += chunk.value.byteLength; } }
    catch { /* ignored: stderr is never surfaced */ }
  }
}

/**
 * One short, read-only command inside a Claude VM (`claude --version`, `--help`, `auth status`): stdin closed at once,
 * stderr discarded, stdout bounded, hard deadline, child always killed. Never used to send prompts.
 */
export async function execClaudeOnce(spawn: MsbSpawn, vm: string, command: string[], timeoutMs: number, reserved?: readonly string[]): Promise<{ code: number | null; stdout: string }> {
  const child = spawn(claudeExecArgv(vm, command, reserved), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: minimalChildEnv() });
  try { await child.stdin.end(); } catch { /* not needed */ }
  void (async () => { const reader = child.stderr.getReader(); try { while (!(await reader.read()).done) { /* discard */ } } catch { /* ignored */ } })();
  let stdout = "";
  const read = (async () => {
    const reader = child.stdout.getReader(); const decoder = new TextDecoder();
    for (;;) { const chunk = await reader.read(); if (chunk.done) return; stdout += decoder.decode(chunk.value, { stream: true }); if (stdout.length > 1024 * 1024) throw new SafeError("claude_output_limit"); }
  })();
  read.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([child.exited.then(value => value as number | null), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
    if (code === null) throw new SafeError("claude_command_timeout");
    await read;
    return { code, stdout };
  } finally { if (timer) clearTimeout(timer); try { child.kill("SIGKILL"); } catch { /* already gone */ } }
}

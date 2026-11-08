import { encodeJsonl, JsonlObjectParser, type JsonObject } from "../../src/jsonl.ts";
import type { MsbChild, MsbSpawn } from "../../src/msb-transport.ts";
import { fakeClaudeSpawn, type FakeClaudeWorld } from "../../src/fake-claude.ts";

/**
 * E4 test double: a Claude stream-json child whose every frame is emitted by the test, at the moment the test chooses
 * (pauses, crashes, late frames). One-shot probe commands (`--version`, `--help`, `auth status`) are answered by the regular
 * fake CLI. Nothing is spawned; no quota.
 */
export interface ScriptedTurn {
  prompt: string;
  sessionId: string;
  /** Write one raw stream-json frame. */
  emit(frame: JsonObject): void;
  messageStart(id: string): void;
  text(delta: string): void;
  assistantText(id: string, text: string): void;
  result(ok?: boolean): void;
  /** The process dies (as a crash or a stopped VM would end `msb exec`). */
  exit(code?: number): void;
}
export interface ScriptedProcess { argv: readonly string[]; sessionId: string; killed: boolean; ended: boolean; controlFrames: JsonObject[] }

export function scriptedClaude(world: FakeClaudeWorld, onTurn: (turn: ScriptedTurn, process: ScriptedProcess) => void): { spawn: MsbSpawn; processes: ScriptedProcess[] } {
  const processes: ScriptedProcess[] = [];
  const fallback = fakeClaudeSpawn(world);
  const spawn: MsbSpawn = (argv, options) => {
    if (!argv.includes("stream-json")) return fallback(argv, options);
    const command = argv.slice(argv.indexOf("--") + 1);
    const resume = command.indexOf("--resume"); const explicit = command.indexOf("--session-id");
    const sessionId = resume >= 0 ? command[resume + 1]! : explicit >= 0 ? command[explicit + 1]! : crypto.randomUUID();
    const record: ScriptedProcess = { argv, sessionId, killed: false, ended: false, controlFrames: [] };
    processes.push(record);
    let out!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start(controller) { out = controller; } });
    const stderr = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { resolveExit = resolve; });
    const finish = (code: number) => { if (record.ended) return; record.ended = true; try { out.close(); } catch { /* closed */ } resolveExit(code); };
    const emit = (frame: JsonObject) => { if (!record.ended) out.enqueue(encodeJsonl(frame)); };
    let initialized = false;
    const parser = new JsonlObjectParser();
    const child: MsbChild = {
      stdin: {
        write(chunk) {
          for (const frame of parser.push(chunk)) {
            if (frame.type === "user" && typeof frame.message === "object" && frame.message) {
              if (!initialized) { initialized = true; emit({ type: "system", subtype: "init", session_id: sessionId, permissionMode: "default", model: "scripted" }); }
              const prompt = String((frame.message as JsonObject).content ?? "");
              onTurn({
                prompt, sessionId, emit,
                messageStart: id => emit({ type: "stream_event", event: { type: "message_start", message: { id, role: "assistant" } } }),
                text: delta => emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } } }),
                assistantText: (id, text) => emit({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }] } }),
                result: (ok = true) => emit({ type: "result", subtype: ok ? "success" : "error_during_execution", is_error: !ok, session_id: sessionId, usage: { input_tokens: 1, output_tokens: 1 } }),
                exit: (code = 1) => finish(code),
              }, record);
            } else record.controlFrames.push(frame);
          }
          return chunk.byteLength;
        },
        end() { finish(0); },
      },
      stdout, stderr, exited,
      kill() { record.killed = true; finish(137); },
    };
    return child;
  };
  return { spawn, processes };
}

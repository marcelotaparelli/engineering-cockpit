import type { MsbChild, MsbSpawn } from "./msb-transport.ts";
import { JsonlObjectParser, encodeJsonl, type JsonObject } from "./jsonl.ts";

/**
 * In-process stand-in for `msb exec --stream <vm> -- claude ...`. Mimics the stream-json shapes the spike expects
 * (UNVERIFIED against a real CLI). Prompt keywords: "approve" (Bash permission), "ask" (AskUserQuestion), "slow" (runs until interrupted),
 * "quota" (429 result), "remember WORD" / "recall" (context across --resume). Nothing is spawned; no network, no quota.
 */
export const FAKE_CLAUDE_VERSION = "2.1.319";
const FLAG_LINES: Record<string, string> = {
  "--print": "  -p, --print   Print response and exit", "--input-format": "  --input-format <format>", "--output-format": "  --output-format <format>",
  "--include-partial-messages": "  --include-partial-messages", "--replay-user-messages": "  --replay-user-messages", "--verbose": "  --verbose",
  "--resume": "  -r, --resume [value]", "--session-id": "  --session-id <uuid>", "--permission-mode": "  --permission-mode <mode>",
  "--permission-prompts": "  --permission-prompts <target>", "--no-session-persistence": "  --no-session-persistence",
};

export interface FakeSpawn { argv: readonly string[]; killed: boolean; ended: boolean; interrupts: number; decisions: string[]; closedByStdin: boolean }
export interface FakeClaudeWorld {
  memory: Map<string, string>; spawned: FakeSpawn[];
  hangOnClose: boolean; omitFlags: string[]; authLoggedIn: boolean; canary: string; initialSession?: string;
}
export const newFakeWorld = (): FakeClaudeWorld => ({ memory: new Map(), spawned: [], hangOnClose: false, omitFlags: [], authLoggedIn: true, canary: "CANARIO-E2" });

const UUID = () => crypto.randomUUID();

export function fakeClaudeSpawn(world: FakeClaudeWorld): MsbSpawn {
  return (argv): MsbChild => {
    const record: FakeSpawn = { argv, killed: false, ended: false, interrupts: 0, decisions: [], closedByStdin: false };
    world.spawned.push(record);
    const enc = new TextEncoder();
    let outController!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start(c) { outController = c; } });
    const stderr = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(`stderr-noise ${world.canary}\n`)); } });
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { resolveExit = resolve; });
    const finish = (code: number) => { if (record.ended) return; record.ended = true; try { outController.close(); } catch { /* closed */ } resolveExit(code); };
    const raw = (value: string) => { if (!record.ended) outController.enqueue(enc.encode(value)); };
    const out = (frame: JsonObject) => { if (!record.ended) outController.enqueue(encodeJsonl(frame)); };
    const child = (write: MsbChild["stdin"]["write"], end: () => void): MsbChild => ({ stdin: { write, end }, stdout, stderr, exited, kill: () => { record.killed = true; finish(137); } });
    const command = argv.slice(argv.indexOf("--") + 1);

    // One-shot commands: raw text, then exit.
    if (command[0] === "claude" && command[1] !== "-p") {
      queueMicrotask(() => {
        if (command[1] === "--version") raw(`${FAKE_CLAUDE_VERSION} (Claude Code)\n`);
        else if (command[1] === "--help") raw(`Usage: claude [options]\n${Object.entries(FLAG_LINES).filter(([flag]) => !world.omitFlags.includes(flag)).map(([, line]) => line).join("\n")}\n`);
        else if (command[1] === "auth" && command[2] === "status") raw(JSON.stringify({ loggedIn: world.authLoggedIn, authMethod: "claude.ai", email: "private@example.invalid", orgName: "ORG-SECRET" }) + "\n");
        finish(0);
      });
      return child(() => 0, () => {});
    }

    // Stream-json mode.
    const resumeIndex = command.indexOf("--resume");
    const sessionIndex = command.indexOf("--session-id");
    const sessionId = resumeIndex >= 0 ? command[resumeIndex + 1]! : sessionIndex >= 0 ? command[sessionIndex + 1]! : UUID();
    const parser = new JsonlObjectParser();
    let turn: { interrupted: boolean; wake: (() => void) | undefined } | null = null;
    const pendingDecisions = new Map<string, (response: JsonObject) => void>();
    let initialized = false;
    const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    const init = () => { if (initialized) return; initialized = true; out({ type: "system", subtype: "init", session_id: sessionId, model: "fake-model", permissionMode: "default", apiKeySource: "none", tools: [] }); };
    const result = (extra: JsonObject = {}) => out({ type: "result", subtype: "success", is_error: false, session_id: sessionId, usage: { input_tokens: 10, output_tokens: 5 }, ...extra });

    const runTurn = async (prompt: string) => {
      const state = { interrupted: false, wake: undefined as (() => void) | undefined };
      turn = state;
      init();
      out({ type: "user", message: { role: "user", content: prompt } }); // --replay-user-messages
      const lower = prompt.toLowerCase();
      const wait = (ms: number) => new Promise<void>(resolve => { const t = setTimeout(resolve, ms); state.wake = () => { clearTimeout(t); resolve(); }; });
      const stream = async (words: string, perWord = 2) => {
        for (const word of words.match(/./gs) ?? []) {
          if (state.interrupted) return false;
          out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: word } } });
          await wait(perWord);
        }
        out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: words }] } });
        return true;
      };
      const ask = (toolName: string, input: JsonObject) => new Promise<JsonObject>(resolve => {
        const requestId = `req-${crypto.randomUUID()}`;
        pendingDecisions.set(requestId, resolve);
        state.wake = () => { pendingDecisions.delete(requestId); resolve({ behavior: "interrupted" }); };
        out({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: toolName, input } });
      });

      if (lower.includes("quota")) { await wait(3); return result({ subtype: "success", is_error: true, api_error_status: 429, result: `secret ${world.canary}` }); }
      const remember = /remember (\w+)/i.exec(prompt);
      if (remember) { world.memory.set(sessionId, remember[1]!); await stream("OK"); return result(); }
      if (lower.includes("recall")) { await stream(world.memory.get(sessionId) ?? "NADA"); return result(); }
      if (lower.includes("slow")) {
        await stream("lento ".repeat(200), 5);
        if (state.interrupted) return result({ subtype: "error_during_execution", is_error: true });
        return result();
      }
      if (lower.includes("approve")) {
        const decision = await ask("Bash", { command: "touch /tmp/e2-approval-probe", description: "probe" });
        record.decisions.push(String(decision.behavior));
        if (decision.behavior === "interrupted") return result({ subtype: "error_during_execution", is_error: true });
        await stream(decision.behavior === "allow" ? "executado" : "recusado");
        return result();
      }
      if (lower.includes("ask")) {
        const decision = await ask("AskUserQuestion", { questions: [{ question: "A ou B?", header: "Escolha", multiSelect: false, options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] });
        record.decisions.push(decision.behavior === "allow" ? "answered" : String(decision.behavior));
        await stream(decision.behavior === "allow" ? "obrigado" : "sem resposta");
        return result();
      }
      await stream(`Resposta simulada. ${world.canary}`);
      return result();
    };

    const queue: string[] = [];
    let running = false;
    const pump = async () => {
      if (running) return; running = true;
      while (queue.length) { const next = queue.shift()!; await runTurn(next); turn = null; }
      running = false;
    };
    const handle = (frame: JsonObject) => {
      if (frame.type === "user" && typeof frame.message === "object" && frame.message) {
        queue.push(String((frame.message as JsonObject).content ?? "")); void pump();
      } else if (frame.type === "control_request" && typeof frame.request === "object" && frame.request) {
        const request = frame.request as JsonObject;
        if (request.subtype === "interrupt") {
          record.interrupts += 1;
          out({ type: "control_response", response: { subtype: "success", request_id: frame.request_id } });
          if (turn) { turn.interrupted = true; turn.wake?.(); }
        }
      } else if (frame.type === "control_response" && typeof frame.response === "object" && frame.response) {
        const response = frame.response as JsonObject;
        const resolve = pendingDecisions.get(String(response.request_id));
        if (resolve) { pendingDecisions.delete(String(response.request_id)); resolve((response.response ?? {}) as JsonObject); }
      }
    };
    return child(chunk => { for (const frame of parser.push(chunk)) handle(frame); return chunk.byteLength; }, () => {
      record.closedByStdin = true;
      if (!world.hangOnClose) { void (async () => { while (running) await sleep(2); finish(0); })(); }
    });
  };
}

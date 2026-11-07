import { SafeError } from "./model.ts";
import { assertArchHost } from "./host.ts";

export const MSB_ARGV = Object.freeze(["msb", "list", "--format", "json"] as const);
export interface Child {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal: "SIGKILL"): void;
}
export type Spawn = (argv: readonly string[], options: { stdin: "ignore"; stdout: "pipe"; stderr: "pipe" }) => Child;
const nativeSpawn: Spawn = (argv, options) => {
  assertArchHost();
  return Bun.spawn([...argv], options);
};
export async function readHostVmList(spawn: Spawn = nativeSpawn, timeoutMs = 3000, byteLimit = 262144): Promise<string> {
  let child: Child;
  try { child = spawn(MSB_ARGV, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }); }
  catch (error) { if (error instanceof SafeError) throw error; throw new SafeError("msb_spawn_failed"); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const capture = async (stream: ReadableStream<Uint8Array>, retain: boolean): Promise<string> => {
    const reader = stream.getReader();
    readers.push(reader);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > byteLimit) throw new SafeError("msb_output_limit");
        if (retain) chunks.push(chunk.value);
      }
      return retain ? new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) : "";
    } finally { reader.releaseLock(); }
  };
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SafeError("msb_timeout")), timeoutMs);
    });
    const result = await Promise.race([
      Promise.all([capture(child.stdout, true), capture(child.stderr, false), child.exited]), timeout,
    ]);
    if (result[2] !== 0) throw new SafeError("msb_exit_failed");
    return result[0];
  } catch (error) {
    try { child.kill("SIGKILL"); } catch { /* Child may already have exited. */ }
    for (const reader of readers) void reader.cancel().catch(() => {});
    if (error instanceof SafeError) throw error;
    throw new SafeError("msb_read_failed");
  } finally { if (timer) clearTimeout(timer); }
}

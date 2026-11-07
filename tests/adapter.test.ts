import { expect, test } from "bun:test";
import { readHostVmList, type Child, type Spawn } from "../src/adapter.ts";
const stream = (text: string) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
function fake(stdout = "[]", stderr = "", code = 0): { spawn: Spawn; killed: string[] } {
  const killed: string[] = [];
  const spawn: Spawn = (argv, options) => {
    expect(argv).toEqual(["msb", "list", "--format", "json"]);
    expect(options).toEqual({ stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { stdout: stream(stdout), stderr: stream(stderr), exited: Promise.resolve(code), kill: signal => { killed.push(signal); } };
  };
  return { spawn, killed };
}
test("adapter has fixed argv and ignored stdin without a shell", async () => {
  const process = fake();
  expect(await readHostVmList(process.spawn)).toBe("[]");
  expect(process.killed).toEqual([]);
});
test("stderr/nonzero sanitized; no raw output in errors", async () => {
  const process = fake("private-project", "secret-token", 1);
  try { await readHostVmList(process.spawn); throw Error("expected failure"); }
  catch (error) { expect(String(error)).toBe("Error: msb_exit_failed"); }
  expect(process.killed).toEqual(["SIGKILL"]);
});
test.each(["stdout", "stderr"] as const)("%s byte limit kills owned child", async channel => {
  const process = fake(channel === "stdout" ? "x".repeat(10) : "[]", channel === "stderr" ? "x".repeat(10) : "");
  expect(readHostVmList(process.spawn, 100, 5)).rejects.toThrow("msb_output_limit");
  await Bun.sleep(1);
  expect(process.killed).toEqual(["SIGKILL"]);
});
test("timeout force kills and cancels pipes even when process ignores termination", async () => {
  const killed: string[] = [];
  let cancelled = 0;
  const stalled = () => new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
  const child: Child = { stdout: stalled(), stderr: stalled(), exited: new Promise(() => {}), kill: signal => { killed.push(signal); } };
  expect(readHostVmList(() => child, 10)).rejects.toThrow("msb_timeout");
  await Bun.sleep(20);
  expect(killed).toEqual(["SIGKILL"]);
  expect(cancelled).toBe(2);
});
test("spawn failures contain safe code only", async () => {
  expect(readHostVmList(() => { throw Error("sensitive host path"); })).rejects.toThrow("msb_spawn_failed");
});

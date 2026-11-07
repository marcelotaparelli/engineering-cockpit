import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHostVmList, type Spawn } from "../src/adapter.ts";
import { parseVmList } from "../src/parser.ts";
import { vmIdentity } from "../src/model.ts";
import { listProjects } from "../src/projects.ts";
import { startServer, type RequestLog } from "../src/server.ts";
import { LocalSecurity } from "../src/local-security.ts";
import { SnapshotStore } from "../src/store.ts";
import type { Snapshot } from "../src/model.ts";

// These tests never start an HTTP listener or invoke the native subprocess adapter.
type Handler = (request: Request, server: { port: number }) => Promise<Response>;
const authority = "127.0.0.1:43129";
const snapshot: Snapshot = { source: "mock", observed_at: "2026-01-01T00:00:00Z", host_verification: "not_verified", projects: ["synthetic"], vms: [] };
function handler(refresh: () => Promise<Snapshot>, logs: RequestLog[]): Handler {
  let captured: Handler | undefined;
  const serve = spyOn(Bun, "serve");
  serve.mockImplementation(((options: { fetch: Handler }) => {
    captured = options.fetch;
    return {};
  }) as unknown as typeof Bun.serve);
  try { startServer({ source: "mock", port: 43129, security: new LocalSecurity("a".repeat(64), ["synthetic"]), discovery: { refresh }, log: entry => logs.push(entry) }); }
  finally { serve.mockRestore(); }
  if (!captured) throw new Error("handler_not_captured");
  return captured;
}
function request(path: string, headers: Record<string, string> = {}, method = "GET", host = authority): Request {
  return new Request(`http://${host}${path}`, { method, headers: { host: authority, ...headers } });
}
async function fixture(run: (base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "cockpit-redteam-"));
  try { await run(base); } finally { await rm(base, { recursive: true, force: true }); }
}
function closed(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
}

test("adversarial H1: rejected authorities, origins, methods, queries and paths never reach discovery", async () => {
  let calls = 0;
  const logs: RequestLog[] = [];
  const fetch = handler(async () => { calls++; return snapshot; }, logs);
  const cases: [Request, number][] = [
    [request("/api/vms", { host: "attacker.invalid:43129" }), 403],
    [request("/api/vms", {}, "GET", "attacker.invalid:43129"), 403],
    [request("/api/vms", { origin: "https://attacker.invalid" }), 403],
    [request("/api/vms", { origin: "null" }), 403],
    [request("/api/vms", { origin: `http://${authority}.attacker.invalid` }), 403],
    [request("/api/vms", { "sec-fetch-site": "cross-site" }), 403],
    [request("/api/vms", { "sec-fetch-site": "same-site" }), 403],
    [request("/api/vms", { origin: `http://${authority}` }, "POST"), 405],
    [request("/api/vms?synthetic-secret=canary"), 400],
    [request("/api/vms?command=synthetic"), 400],
    [request("/%2e%2e/synthetic-secret"), 404],
    [request("/api/vms%2f..%2fsynthetic-secret"), 404],
    [request("/__proto__"), 404],
    [request("/constructor"), 404],
  ];
  for (const [input, status] of cases) {
    const response = await fetch(input, { port: 43129 });
    expect(response.status).toBe(status);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.text()).not.toContain("synthetic-secret");
  }
  expect(calls).toBe(0);
  expect(logs.every(entry => entry.event === "security_denied")).toBe(true);
  expect(JSON.stringify(logs)).not.toContain("synthetic-secret");
  expect(JSON.stringify(logs)).not.toContain("attacker.invalid");
  const response = await fetch(request("/api/vms", { origin: `http://${authority}`, "sec-fetch-site": "same-origin" }), { port: 43129 });
  expect(response.status).toBe(401);
  expect(calls).toBe(0);
});

test("adversarial H2: directory and SQLite symlinks plus foreign schemas are rejected without sentinel mutation", async () => {
  await fixture(async base => {
    const projects = join(base, "projects");
    const outside = join(base, "outside");
    await mkdir(projects); await mkdir(outside); await mkdir(join(projects, "synthetic"));
    await mkdir(join(outside, "outside-only"));
    await symlink(outside, join(projects, "escape"));
    expect(await listProjects(projects)).toEqual(["synthetic"]);
    await symlink(outside, join(base, "project-link"));
    await expect(listProjects(join(base, "project-link"))).rejects.toThrow("symlink_path_denied");

    const foreign = join(outside, "foreign.sqlite");
    const other = new Database(foreign);
    other.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('synthetic-canary');");
    other.close();
    const before = await readFile(foreign);
    expect(() => new SnapshotStore(foreign)).toThrow("foreign_database_denied");
    expect(await readFile(foreign)).toEqual(before);
    const dbLink = join(base, "cockpit.sqlite");
    await symlink(foreign, dbLink);
    expect(() => new SnapshotStore(dbLink)).toThrow("symlink_path_denied");
    expect(await readFile(foreign)).toEqual(before);
  });
});

test("adversarial H2: main database hardlinks and sidecar symlinks are refused", async () => {
  await fixture(async base => {
    const target = join(base, "synthetic-target");
    await writeFile(target, "synthetic-canary");
    const db = join(base, "cockpit.sqlite");
    await link(target, db);
    expect(() => new SnapshotStore(db)).toThrow("unsafe_database_file");
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const path = join(base, `sidecar${suffix}.sqlite`);
      await symlink(target, path + suffix);
      expect(() => new SnapshotStore(path)).toThrow("symlink_path_denied");
    }
    expect(await readFile(target, "utf8")).toBe("synthetic-canary");
  });
});

test("adversarial H2 probe: journal hardlink must not modify a synthetic outside sentinel", async () => {
  await fixture(async base => {
    const db = join(base, "cockpit.sqlite");
    const initial = new SnapshotStore(db); initial.close();
    const sentinel = join(base, "unrelated-synthetic-file");
    const before = Buffer.alloc(8192, 65);
    await writeFile(sentinel, before);
    await link(sentinel, db + "-journal");
    let store: SnapshotStore | undefined;
    try { store = new SnapshotStore(db); store.replace(snapshot); }
    catch { /* Refusal is acceptable; mutation of the sentinel is not. */ }
    finally { store?.close(); }
    expect(await readFile(sentinel)).toEqual(before);
  });
});

test("adversarial H3: shell and markup names are rejected and raw subprocess errors stay out of logs", async () => {
  for (const name of ["codex-../escape", "codex-$(synthetic)", "codex-a;synthetic", "codex-<svg>", "codex-a\ncanary"]) {
    // Never an agent VM, never in the inventory, never reaches msb exec (strict grammar unchanged).
    expect(parseVmList(JSON.stringify([{ created_at: "2026-10-25T13:54:12Z", image: "node:22", name, status: "Running" }]))).toEqual([]);
    expect(() => vmIdentity(name)).toThrow("invalid_vm_name");
  }
  const canary = "SYNTHETIC_STDERR_CANARY";
  let calls = 0;
  const spawn: Spawn = (argv, options) => {
    calls++;
    expect(argv).toEqual(["msb", "list", "--format", "json"]);
    expect(options).toEqual({ stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { stdout: closed(canary), stderr: closed(canary), exited: Promise.resolve(9), kill() {} };
  };
  const logs: RequestLog[] = [];
  const fetch = handler(async () => { await readHostVmList(spawn); return snapshot; }, logs);
  const login = await fetch(new Request(`http://${authority}/api/auth/login`, { method: "POST", headers: { host: authority, origin: `http://${authority}`, "content-type": "application/json" }, body: JSON.stringify({ credential: "a".repeat(64) }) }), { port: 43129 });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const proof = (await login.json() as { proof: string }).proof;
  const response = await fetch(request("/api/vms", { cookie, "x-session-proof": proof }), { port: 43129 });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain(canary);
  expect(JSON.stringify(logs)).not.toContain(canary);
  expect(logs.at(-1)?.error_code).toBe("msb_exit_failed");
  expect(calls).toBe(1);
});

test("adversarial H3: timeout kills only the fake child and cancels both fake streams", async () => {
  const killed: string[] = [];
  let cancelled = 0;
  const stream = () => new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
  const spawn: Spawn = () => ({ stdout: stream(), stderr: stream(), exited: new Promise(() => {}), kill(signal) { killed.push(signal); } });
  await expect(readHostVmList(spawn, 5)).rejects.toThrow("msb_timeout");
  expect(killed).toEqual(["SIGKILL"]);
  expect(cancelled).toBe(2);
});

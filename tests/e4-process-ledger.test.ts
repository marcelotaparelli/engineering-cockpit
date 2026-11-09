import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore } from "../src/runtime-store.ts";
import { classifyChild, procProbe, ProcessLedger, type ProcessLedgerLog } from "../src/process-ledger.ts";
import type { MsbChild, MsbSpawn } from "../src/msb-transport.ts";
import { buildDashboard } from "../src/dashboard.ts";
import { LocalSecurity, type LocalPrincipal } from "../src/local-security.ts";
import { closeHarnesses, harness, startTurn } from "./support/e4-harness.ts";

/**
 * E4 — orphaned msb children. Controlled REAL processes (`sleep`) stand in for `msb exec`, so PIDs, kernel start times and
 * liveness come from the real /proc. A "crashed" previous Cockpit is a ledger whose owner identity belongs to no live process.
 */
const SESSION = "11111111-2222-4333-8444-555555555555";
const claudeArgv = (vm = "claude-alpha", session = SESSION) => ["msb", "exec", "--stream", vm, "--", "claude", "-p", "--input-format", "stream-json", "--resume", session];
const codexArgv = (vm = "codex-alpha") => ["msb", "exec", "--stream", vm, "--", "codex", "app-server", "--listen", "stdio://"];
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } await child.exited; }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  await closeHarnesses();
});

/** Runs `sleep` whatever the msb argv says: a real, controllable stand-in for the msb child. */
const realSpawn: MsbSpawn = () => {
  const child = Bun.spawn(["sleep", "30"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  children.push(child);
  return child as unknown as MsbChild;
};
async function deadIdentity(): Promise<{ pid: number; startTicks: string }> {
  const gone = Bun.spawn(["true"]);
  await gone.exited;
  return { pid: gone.pid, startTicks: "1" };
}
async function store(): Promise<{ store: RuntimeStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cockpit-e4-ledger-"));
  dirs.push(dir);
  const path = join(dir, "runtime", "runtime.sqlite");
  return { store: new RuntimeStore(path), path };
}
const quiet = () => {};

describe("E4: process ledger", () => {
  test("argv classification: Codex app-server, Claude session (with its id), one-shot Claude command; anything else is ignored", () => {
    expect(classifyChild(codexArgv())).toEqual({ kind: "codex_app_server", vmName: "codex-alpha", providerSessionId: null });
    expect(classifyChild(claudeArgv())).toEqual({ kind: "claude_session", vmName: "claude-alpha", providerSessionId: SESSION });
    expect(classifyChild(["msb", "exec", "--stream", "claude-alpha", "--", "claude", "--version"])).toMatchObject({ kind: "claude_command" });
    expect(classifyChild(["msb", "list", "--format", "json"])).toBeNull();
    expect(classifyChild(["sh", "-c", "x"])).toBeNull();
  });

  test.skipIf(process.platform !== "linux")("a child that exits normally is forgotten; one that outlives its crashed owner becomes an orphan", async () => {
    const { store: s } = await store();
    const crashed = new ProcessLedger(s, { self: await deadIdentity(), log: quiet });
    const spawn = crashed.track(realSpawn);
    const finished = spawn(claudeArgv("claude-alpha", "22222222-2222-4333-8444-555555555555"), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} });
    const survivor = spawn(claudeArgv(), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} });
    expect(s.childProcesses()).toHaveLength(2);
    finished.kill("SIGKILL");
    await finished.exited; await Bun.sleep(10);
    expect(s.childProcesses().map(row => row.pid)).toEqual([survivor.pid!]);

    const logs: ProcessLedgerLog[] = [];
    const next = new ProcessLedger(s, { log: entry => { logs.push(entry); } });
    expect(next.recover()).toEqual({ orphans: 1, forgotten: 0, foreign: 0 });
    expect(next.orphans()).toEqual([expect.objectContaining({ pid: survivor.pid, kind: "claude_session", vmName: "claude-alpha", providerSessionId: SESSION })]);
    expect(logs).toContainEqual(expect.objectContaining({ event: "process.orphan_detected", pid: survivor.pid, kind: "claude_session" }));
    // Only the same session is blocked; another session of the VM is not.
    expect(next.blocking("claude-alpha", SESSION)).toMatchObject({ pid: survivor.pid });
    expect(next.blocking("claude-alpha", "33333333-2222-4333-8444-555555555555")).toBeNull();

    // The operator ends it: the next read notices, forgets it and unblocks — the Cockpit never signalled it.
    survivor.kill("SIGKILL"); await survivor.exited;
    expect(next.orphans()).toEqual([]);
    expect(next.blocking("claude-alpha", SESSION)).toBeNull();
    expect(s.childProcesses()).toEqual([]);
  });

  test.skipIf(process.platform !== "linux")("a reused PID (different kernel start time) is never taken for the orphan; a live owner's children are left alone", async () => {
    const { store: s } = await store();
    const live = realSpawn([], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} });
    const ticks = procProbe.startTicks(live.pid!)!;
    const dead = await deadIdentity();
    s.recordChild({ pid: live.pid!, startTicks: String(BigInt(ticks) + 1n), ownerPid: dead.pid, ownerStartTicks: dead.startTicks, kind: "codex_app_server",
      vmName: "codex-alpha", providerSessionId: null, createdAt: new Date().toISOString() });
    // Owner alive (the `live` process plays another running Cockpit): untouched, never reported.
    const other = realSpawn([], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} });
    s.recordChild({ pid: other.pid!, startTicks: procProbe.startTicks(other.pid!)!, ownerPid: live.pid!, ownerStartTicks: ticks, kind: "claude_session",
      vmName: "claude-alpha", providerSessionId: SESSION, createdAt: new Date().toISOString() });
    const ledger = new ProcessLedger(s, { log: quiet });
    expect(ledger.recover()).toEqual({ orphans: 0, forgotten: 1, foreign: 1 });
    expect(ledger.orphans()).toEqual([]);
    expect(s.childProcesses().map(row => row.pid)).toEqual([other.pid!]);
  });

  test.skipIf(process.platform !== "linux")("a Codex app-server orphan blocks its whole VM; a one-shot probe orphan blocks nothing", async () => {
    const { store: s } = await store();
    const crashed = new ProcessLedger(s, { self: await deadIdentity(), log: quiet });
    const spawn = crashed.track(realSpawn);
    spawn(codexArgv(), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} });
    spawn(["msb", "exec", "--stream", "claude-alpha", "--", "claude", "--version"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} });
    const ledger = new ProcessLedger(s, { log: quiet });
    expect(ledger.recover().orphans).toBe(2);
    expect(ledger.blocking("codex-alpha", "any-thread")).toMatchObject({ kind: "codex_app_server" });
    expect(ledger.blocking("claude-alpha", SESSION)).toBeNull();
  });

  test("in-process doubles (no PID) and ledger write failures never break a spawn", async () => {
    const { store: s } = await store();
    const ledger = new ProcessLedger(s, { log: quiet, probe: { startTicks: () => "7" } });
    const double: MsbSpawn = () => ({ stdin: { write: () => 0, end: () => {} }, stdout: new ReadableStream(), stderr: new ReadableStream(), exited: new Promise(() => {}), kill: () => {} });
    expect(() => ledger.track(double)(claudeArgv(), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} })).not.toThrow();
    expect(s.childProcesses()).toEqual([]);
    s.close();
    const logs: ProcessLedgerLog[] = [];
    const broken = new ProcessLedger(s, { log: entry => { logs.push(entry); }, probe: { startTicks: () => "7" } });
    const withPid: MsbSpawn = () => ({ stdin: { write: () => 0, end: () => {} }, stdout: new ReadableStream(), stderr: new ReadableStream(), exited: new Promise(() => {}), kill: () => {}, pid: 4242 });
    expect(() => broken.track(withPid)(claudeArgv(), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} })).not.toThrow();
    expect(logs).toContainEqual(expect.objectContaining({ event: "process.ledger_failed", outcome: "record" }));
  });

  test("an exact v4 database migrates to v5 additively; rows are preserved", async () => {
    const { store: s, path } = await store();
    const at = new Date().toISOString();
    s.createSession({ sessionId: "ses-1", target: { provider: "claude", projectId: "alpha", vmName: "claude-alpha", vmInstanceId: null, discoveryVersion: at },
      providerSessionId: SESSION, createdAt: at, lastObservedAt: at });
    s.db.exec("DROP TABLE child_processes; PRAGMA user_version=4;");
    s.close();
    const migrated = new RuntimeStore(path);
    try {
      expect((migrated.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(5);
      expect(migrated.getSession("ses-1")).toMatchObject({ providerSessionId: SESSION });
      expect(migrated.childProcesses()).toEqual([]);
    } finally { migrated.close(); }
  });
});

describe.skipIf(process.platform !== "linux")("E4: a run never starts beside an orphan of its session", () => {
  test("refused before anything is created or sent; allowed again once the orphan is gone; visible in the dashboard", async () => {
    let survivor: MsbChild | undefined;
    let ledger: ProcessLedger | undefined;
    const h = await harness({ processes: s => {
      ledger = new ProcessLedger(s, { log: quiet });
      return ledger;
    } });
    // First run opens the session normally (no orphan yet).
    const { session, run, turn } = await startTurn(h);
    turn.result(true);
    for (const deadline = Date.now() + 2000; h.store.getRun(run.runId)!.status !== "completed"; await Bun.sleep(5)) if (Date.now() > deadline) throw new Error("not completed");
    // A previous, crashed Cockpit left a Claude process of THIS session running.
    const crashed = new ProcessLedger(h.store, { self: await deadIdentity(), log: quiet });
    survivor = crashed.track(realSpawn)(claudeArgv("claude-alpha", session.providerSessionId), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} });
    expect(ledger!.recover().orphans).toBe(1);

    const runsBefore = h.store.listRuns(session.sessionId, 50).length;
    await expect(h.execution.startRun(session, "outra tarefa", `key-${crypto.randomUUID()}`)).rejects.toThrow("orphan_process_alive");
    expect(h.store.listRuns(session.sessionId, 50)).toHaveLength(runsBefore);
    expect(h.store.transcriptPage(session.sessionId).items.filter(item => item.kind === "user_message")).toHaveLength(1);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "run.dispatch_blocked", error_code: "orphan_process_alive" }));

    const principal = { grants: new Set(["alpha"]) } as unknown as LocalPrincipal;
    const dashboard = buildDashboard({ store: h.store, execution: h.execution, principal, security: new LocalSecurity("a".repeat(64), ["alpha"]), snapshot: null, discoveryError: null, source: "mock" });
    expect(dashboard.attention).toContainEqual(expect.objectContaining({ kind: "orphan_process", pid: survivor.pid, process_kind: "claude_session", blocks: "session", session_id: session.sessionId }));
    const outsider = buildDashboard({ store: h.store, execution: h.execution, principal: { grants: new Set(["beta"]) } as unknown as LocalPrincipal, security: new LocalSecurity("a".repeat(64), ["alpha"]), snapshot: null, discoveryError: null, source: "mock" });
    expect((outsider.attention as Array<{ kind: string }>).some(item => item.kind === "orphan_process")).toBe(false);

    survivor.kill("SIGKILL"); await survivor.exited;
    const { run: next, created } = await h.execution.startRun(session, "outra tarefa", `key-${crypto.randomUUID()}`);
    expect(created).toBe(true);
    (await h.nextTurn()).result(true);
    for (const deadline = Date.now() + 2000; h.store.getRun(next.runId)!.status !== "completed"; await Bun.sleep(5)) if (Date.now() > deadline) throw new Error("not completed");
  });
});

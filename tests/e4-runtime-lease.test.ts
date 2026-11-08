import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { procDatabaseHolders, RuntimeStore } from "../src/runtime-store.ts";
import type { ExecutionTarget } from "../src/provider.ts";

/**
 * E4 — one Cockpit per runtime database. A second instance on the same data directory would otherwise run startup recovery
 * against a LIVE instance: mark its in-flight runs `unknown`, expire the approvals a human is about to decide and free the
 * project lock for a second, concurrent writer. Controlled real processes (`sleep` holding the file) stand in for that instance.
 */
const target: ExecutionTarget = { provider: "claude", projectId: "alpha", vmName: "claude-alpha", vmInstanceId: null, discoveryVersion: "2026-11-08T00:00:00.000Z" };
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } await child.exited; }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function seeded(): Promise<{ path: string; runId: string; approvalId: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cockpit-e4-lease-"));
  dirs.push(dir);
  const path = join(dir, "runtime", "runtime.sqlite");
  const store = new RuntimeStore(path);
  const at = new Date().toISOString();
  store.createSession({ sessionId: "ses-1", target, providerSessionId: "00000000-0000-4000-8000-000000000001", createdAt: at, lastObservedAt: at });
  const { run } = store.beginRun({ runId: "run-1", sessionId: "ses-1", idempotencyKey: "key-1", requestDigest: "a".repeat(64), createdAt: at, exclusiveProject: "alpha" });
  store.transition(run.runId, 1, "dispatching", at);
  store.transition(run.runId, 2, "running", at, { providerRunId: "turn-1" });
  store.createApproval({ approvalId: "apr-1", runId: "run-1", actionType: "command", actionDigest: "b".repeat(64), createdAt: at, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  store.transition(run.runId, 3, "awaiting_approval", at);
  store.close();
  return { path, runId: "run-1", approvalId: "apr-1" };
}

/** A real, separate process that keeps the database file open (as another Cockpit instance would). */
async function holdOpen(path: string): Promise<Bun.Subprocess> {
  const child = Bun.spawn(["sh", "-c", 'exec sleep 30 < "$0"', path], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  children.push(child);
  for (const deadline = Date.now() + 3000; !(procDatabaseHolders(path) ?? []).includes(child.pid); await Bun.sleep(10)) {
    if (Date.now() > deadline) throw new Error("holder not observed");
  }
  return child;
}

describe.skipIf(process.platform !== "linux")("E4: exclusive runtime database", () => {
  test("a second instance refuses to start while another process holds the database; the live state is left untouched", async () => {
    const { path, runId, approvalId } = await seeded();
    const holder = await holdOpen(path);
    expect(() => new RuntimeStore(path)).toThrow("runtime_database_in_use");

    // Nothing was recovered, expired or migrated by the refused instance.
    holder.kill("SIGKILL"); await holder.exited;
    const ownership: string[] = [];
    const reopened = new RuntimeStore(path, new Date().toISOString(), {}, { holders: () => { ownership.push("checked"); return []; } });
    try {
      expect(ownership).toEqual(["checked"]);
      // Only this (accepted) open recovered the run: the refused one did not leave a `process_restarted` trace before it.
      const run = reopened.getRun(runId)!;
      expect(run).toMatchObject({ status: "unknown", reasonCode: "process_restarted" });
      expect(reopened.replay(0, 1000).filter(event => event.type === "run.recovery_unknown")).toHaveLength(1);
      expect(reopened.getApproval(approvalId)).toMatchObject({ status: "expired", reasonCode: "process_restarted" });
    } finally { reopened.close(); }
  });

  test("once the holder is gone, the next start takes over and recovers exactly once", async () => {
    const { path, runId } = await seeded();
    const holder = await holdOpen(path);
    expect(() => new RuntimeStore(path)).toThrow("runtime_database_in_use");
    holder.kill("SIGKILL"); await holder.exited;
    for (const deadline = Date.now() + 3000; (procDatabaseHolders(path) ?? []).length > 0; await Bun.sleep(10)) if (Date.now() > deadline) throw new Error("holder still visible");
    const store = new RuntimeStore(path);
    try {
      expect(store.ownership).toBe("exclusive");
      expect(store.getRun(runId)).toMatchObject({ status: "unknown", reasonCode: "process_restarted", lifecycleVersion: 5 });
    } finally { store.close(); }
  });

  test("the Cockpit's own children never count as holders (SQLite descriptors are close-on-exec)", async () => {
    const { path } = await seeded();
    const store = new RuntimeStore(path);
    try {
      const child = Bun.spawn(["sleep", "30"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      children.push(child);
      await Bun.sleep(50);
      // Seen from a third party: only this process holds it, never the child (which outlives a crash of its parent).
      expect(procDatabaseHolders(path, -1)).toEqual([process.pid]);
      expect(procDatabaseHolders(path)).toEqual([]);
    } finally { store.close(); }
  });

  test("a platform that cannot tell is reported as not verified instead of silently claiming exclusivity", async () => {
    const { path } = await seeded();
    const store = new RuntimeStore(path, new Date().toISOString(), {}, { holders: () => null });
    try { expect(store.ownership).toBe("not_verified"); } finally { store.close(); }
  });
});

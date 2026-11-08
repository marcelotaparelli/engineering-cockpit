import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunCoordinator } from "../src/run-coordinator.ts";
import { RuntimeStore, type SessionRecord } from "../src/runtime-store.ts";
import { MsbStdioTransport, type MsbSpawn } from "../src/msb-transport.ts";

const base = await mkdtemp(join(tmpdir(), "cockpit-m0b-runtime-"));
afterAll(async () => { await rm(base, { recursive: true, force: true }); });
const at = (second: number) => `2026-10-25T00:00:${String(second).padStart(2, "0")}.000Z`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function session(id: string, providerSessionId = `provider-${id}`): SessionRecord {
  return {
    sessionId: id,
    target: { provider: "codex", projectId: "demo", vmName: "codex-demo", vmInstanceId: null, discoveryVersion: "snapshot-1" },
    providerSessionId,
    createdAt: at(0),
    lastObservedAt: at(0),
  };
}

describe("separate runtime SQLite", () => {
  test("idempotency stores only a scoped key hash and returns one execution", async () => {
    const path = join(base, "idempotency.sqlite"); const store = new RuntimeStore(path, at(0));
    store.createSession(session("session-a")); store.createSession(session("session-b"));
    const input = { runId: "run-a", sessionId: "session-a", idempotencyKey: "SYNTHETIC-IDEMPOTENCY-SECRET", requestDigest: digest("request-a"), createdAt: at(1) };
    const first = store.beginRun(input); const retry = store.beginRun({ ...input, runId: "ignored-retry-id" });
    expect(first.created).toBe(true); expect(retry.created).toBe(false);
    expect(retry.run.runId).toBe("run-a"); expect(retry.run.executionCount).toBe(1);
    expect(retry.run.idempotencyKeyHash).toBe(digest(input.idempotencyKey));
    expect(() => store.beginRun({ ...input, runId: "run-conflict", requestDigest: digest("different") })).toThrow("idempotency_key_conflict");
    const otherScope = store.beginRun({ ...input, runId: "run-b", sessionId: "session-b" });
    expect(otherScope.created).toBe(true);
    store.close();
    const bytes = await readFile(path);
    expect(bytes.includes(Buffer.from(input.idempotencyKey))).toBe(false);
    expect(bytes.includes(Buffer.from("request-a"))).toBe(false);
  });

  test("prepared survives restart while possibly dispatched work becomes unknown without replay", () => {
    const path = join(base, "recovery.sqlite");
    const initial = new RuntimeStore(path, at(0)); initial.createSession(session("session-recovery"));
    const coordinator = new RunCoordinator(initial);
    const prepared = coordinator.begin({ runId: "run-prepared", sessionId: "session-recovery", idempotencyKey: "key-prepared", requestDigest: digest("prepared"), createdAt: at(1) }).run;
    const dispatching = coordinator.begin({ runId: "run-dispatching", sessionId: "session-recovery", idempotencyKey: "key-dispatching", requestDigest: digest("dispatching"), createdAt: at(1) }).run;
    coordinator.markDispatching(dispatching.runId, dispatching.lifecycleVersion, at(2));
    const running = coordinator.begin({ runId: "run-running", sessionId: "session-recovery", idempotencyKey: "key-running", requestDigest: digest("running"), createdAt: at(1) }).run;
    const marked = coordinator.markDispatching(running.runId, running.lifecycleVersion, at(2));
    coordinator.markProviderBound(running.runId, marked.lifecycleVersion, "provider-run-1", at(3));
    initial.close();

    const reopened = new RuntimeStore(path, at(4));
    expect(reopened.getRun(prepared.runId)?.status).toBe("prepared");
    expect(reopened.getRun(dispatching.runId)?.status).toBe("unknown");
    expect(reopened.getRun(running.runId)?.status).toBe("unknown");
    expect(reopened.getRun(dispatching.runId)?.reasonCode).toBe("process_restarted");
    expect(reopened.getRun(running.runId)?.executionCount).toBe(1);
    const retry = reopened.beginRun({ runId: "never-created", sessionId: "session-recovery", idempotencyKey: "key-running", requestDigest: digest("running"), createdAt: at(5) });
    expect(retry.created).toBe(false); expect(retry.run.status).toBe("unknown"); expect(retry.run.executionCount).toBe(1);
    reopened.close();
  });

  test("CAS lifecycle and transport loss preserve conservative state", () => {
    const store = new RuntimeStore(join(base, "cas.sqlite"), at(0)); store.createSession(session("session-cas"));
    const coordinator = new RunCoordinator(store);
    const beforeMarker = coordinator.begin({ runId: "run-before-marker", sessionId: "session-cas", idempotencyKey: "key-before", requestDigest: digest("before"), createdAt: at(1) }).run;
    expect(coordinator.markTerminal(beforeMarker.runId, beforeMarker.lifecycleVersion, "failed", at(2), "pre_dispatch_failed").status).toBe("failed");
    const run = coordinator.begin({ runId: "run-cas", sessionId: "session-cas", idempotencyKey: "key-cas", requestDigest: digest("cas"), createdAt: at(1) }).run;
    const dispatching = coordinator.markDispatching(run.runId, 1, at(2));
    expect(() => coordinator.markProviderBound(run.runId, 1, "provider-run-cas", at(3))).toThrow("run_version_conflict");
    const unknown = coordinator.markTransportLoss(run.runId, dispatching.lifecycleVersion, at(3));
    expect(unknown.status).toBe("unknown"); expect(unknown.reasonCode).toBe("transport_lost");
    expect(() => coordinator.markTerminal(run.runId, unknown.lifecycleVersion - 1, "completed", at(4))).toThrow("run_version_conflict");
    store.close();
  });

  test("the reproduced crash with an empty rollout is persisted as unknown", async () => {
    const fixture = await Bun.file(new URL("../fixtures/m0b/crash-empty-rollout.json", import.meta.url)).json() as { stdout: string; exitCode: number; expectedStatus: "unknown" };
    const store = new RuntimeStore(join(base, "empty-rollout.sqlite"), at(0)); store.createSession(session("session-empty"));
    const coordinator = new RunCoordinator(store);
    const run = coordinator.begin({ runId: "run-empty", sessionId: "session-empty", idempotencyKey: "key-empty", requestDigest: digest("empty"), createdAt: at(1) }).run;
    const dispatching = coordinator.markDispatching(run.runId, run.lifecycleVersion, at(2));
    const closed = (text: string) => new ReadableStream<Uint8Array>({ start(controller) { if (text) controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
    const spawn: MsbSpawn = () => ({
      stdin: { write(data) { return data.byteLength; }, end() {} }, stdout: closed(fixture.stdout), stderr: closed(""),
      exited: Promise.resolve(fixture.exitCode), kill() {},
    });
    const transport = new MsbStdioTransport("codex-demo", spawn, { shutdownGraceMs: 5 });
    await expect(transport.request("fixture/run", {})).rejects.toThrow();
    const recovered = coordinator.markTransportLoss(run.runId, dispatching.lifecycleVersion, at(3));
    expect(recovered.status).toBe(fixture.expectedStatus);
    await transport.close(); store.close();
  });

  test("journal is canonical, monotonic, replayable and rejects content fields", () => {
    const store = new RuntimeStore(join(base, "journal.sqlite"), at(0)); store.createSession(session("session-journal"));
    const run = store.beginRun({ runId: "run-journal", sessionId: "session-journal", idempotencyKey: "key-journal", requestDigest: digest("journal"), createdAt: at(1) }).run;
    store.transition(run.runId, run.lifecycleVersion, "failed", at(2), { reasonCode: "synthetic_failure" });
    store.appendJournal({ eventId: "manual-event", runId: run.runId, type: "operation.notice", occurredAt: at(3), payload: { reasonCode: "synthetic_notice" } });
    expect(() => store.appendJournal({ eventId: "denied-event", runId: run.runId, type: "operation.notice", occurredAt: at(3), payload: { prompt: "SYNTHETIC_PROMPT" } })).toThrow("journal_payload_denied");
    const events = store.replay();
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3]);
    expect(events[1]?.payload).toEqual({ from: "prepared", reasonCode: "synthetic_failure", to: "failed" });
    expect(store.replay(2).map(event => event.eventId)).toEqual(["manual-event"]);
    const raw = store.db.prepare("SELECT payload_json FROM journal WHERE event_id='run-journal:2'").get() as { payload_json: string };
    expect(raw.payload_json).toBe('{"from":"prepared","reasonCode":"synthetic_failure","to":"failed"}');
    store.close();
  });

  test("database, hardlinks and sidecar symlinks fail closed", async () => {
    const target = join(base, "outside-sentinel"); await writeFile(target, "SYNTHETIC_SENTINEL");
    const hardlink = join(base, "hardlink.sqlite"); await link(target, hardlink);
    expect(() => new RuntimeStore(hardlink, at(0))).toThrow("unsafe_database_file");
    const path = join(base, "sidecar.sqlite"); await symlink(target, `${path}-journal`);
    expect(() => new RuntimeStore(path, at(0))).toThrow("symlink_path_denied");
    expect(await readFile(target, "utf8")).toBe("SYNTHETIC_SENTINEL");
  });

  test("runtime database requires a private parent directory", async () => {
    const publicParent = join(base, "runtime-public");
    await mkdir(publicParent); await chmod(publicParent, 0o755);
    expect(() => new RuntimeStore(join(publicParent, "runtime.sqlite"), at(0))).toThrow("unsafe_runtime_directory");
  });
});

describe("runtime schema v2", () => {
  test("an exact v1 database migrates additively; altered schemas stay refused", async () => {
    const dir = join(base, "migrate");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "runtime.sqlite");
    const store = new RuntimeStore(path);
    store.createSession(session("ses-v1"));
    store.beginRun({ runId: "run-v1", sessionId: "ses-v1", idempotencyKey: "key-v1", requestDigest: digest("v1"), createdAt: at(1) });
    // Downgrade to the exact v1 layout produced by M0b.1b.
    store.db.exec("DROP INDEX transcript_by_session; DROP TABLE transcript_items; DROP INDEX approvals_by_status; DROP INDEX runs_by_session; DROP TABLE approvals; DROP TABLE run_metrics; PRAGMA user_version=1;");
    store.close();
    const migrated = new RuntimeStore(path);
    expect(migrated.getRun("run-v1")?.status).toBe("prepared");
    expect((migrated.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(4); // v1 → v2 → v3 → v4 in one open
    expect(migrated.pendingApprovals()).toEqual([]);
    migrated.db.exec("CREATE TABLE intruder (x TEXT)");
    migrated.close();
    expect(() => new RuntimeStore(path)).toThrow("foreign_runtime_database_denied");
  });

  test("an exact v2 database migrates to v3 preserving approvals and metrics; tool/question approvals and per-run tokens fit", async () => {
    const dir = join(base, "migrate-v3");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "runtime.sqlite");
    const store = new RuntimeStore(path);
    store.createSession(session("ses-v2"));
    store.beginRun({ runId: "run-v2", sessionId: "ses-v2", idempotencyKey: "key-v2", requestDigest: digest("v2"), createdAt: at(1) });
    // Rebuild the exact v2 layout (narrow CHECKs) with one approval and one metrics row in it.
    store.db.exec(`DROP INDEX transcript_by_session; DROP TABLE transcript_items; DROP INDEX approvals_by_status; DROP TABLE approvals; DROP TABLE run_metrics;
      CREATE TABLE approvals (approval_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), action_type TEXT NOT NULL CHECK(action_type IN ('command','file_change')), action_digest TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','expired')), version INTEGER NOT NULL CHECK(version >= 1), created_at TEXT NOT NULL, expires_at TEXT NOT NULL, resolved_at TEXT, reason_code TEXT);
      CREATE TABLE run_metrics (run_id TEXT PRIMARY KEY REFERENCES runs(run_id), input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER, token_scope TEXT NOT NULL CHECK(token_scope IN ('not_measured','session_cumulative')), updated_at TEXT NOT NULL);
      CREATE INDEX approvals_by_status ON approvals(status, run_id);
      INSERT INTO approvals VALUES ('apr-old', 'run-v2', 'command', '${digest("x")}', 'pending', 1, '${at(2)}', '${at(59)}', NULL, NULL);
      INSERT INTO run_metrics VALUES ('run-v2', 7, 8, NULL, 'session_cumulative', '${at(3)}');
      PRAGMA user_version=2;`);
    store.close();
    const migrated = new RuntimeStore(path);
    expect((migrated.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(4); // v2 → v3 → v4
    // Restart recovery expires the pending approval (handles never survive), but the row and its history are kept.
    expect(migrated.getApproval("apr-old")).toMatchObject({ actionType: "command", status: "expired", reasonCode: "process_restarted" });
    expect(migrated.metrics(migrated.getRun("run-v2")!)).toMatchObject({ inputTokens: 7, outputTokens: 8, tokenScope: "session_cumulative" });
    migrated.createApproval({ approvalId: "apr-q", runId: "run-v2", actionType: "question", actionDigest: digest("q"), createdAt: at(4), expiresAt: at(59) });
    migrated.createApproval({ approvalId: "apr-t", runId: "run-v2", actionType: "tool", actionDigest: digest("t"), createdAt: at(4), expiresAt: at(59) });
    expect(migrated.resolveApproval("apr-q", 1, "approved", at(5), "human_answer").approval).toMatchObject({ status: "approved", reasonCode: "human_answer" });
    expect(() => migrated.resolveApproval("apr-t", 1, "approved", at(5), "auto" as never)).toThrow("invalid_reason_code");
    migrated.recordUsage("run-v2", { inputTokens: 1, outputTokens: 2 }, at(6), "run");
    expect(migrated.metrics(migrated.getRun("run-v2")!).tokenScope).toBe("run");
    migrated.close();
    expect(new RuntimeStore(path).getApproval("apr-t")?.status).toBe("expired"); // reopens cleanly as exact v3
  });

  test("approvals: content-free journal, CAS, identical replay no-op, expiry", () => {
    const dir = join(base, "approvals");
    const store = new RuntimeStore(join(dir, "runtime.sqlite"));
    store.createSession(session("ses-a"));
    store.beginRun({ runId: "run-a1", sessionId: "ses-a", idempotencyKey: "key-a1", requestDigest: digest("a"), createdAt: at(1) });
    store.createApproval({ approvalId: "apr-1", runId: "run-a1", actionType: "command", actionDigest: digest("rm -rf /"), createdAt: at(2), expiresAt: at(50) });
    expect(() => store.resolveApproval("apr-1", 2, "approved", at(3))).toThrow("approval_conflict");
    expect(store.resolveApproval("apr-1", 1, "approved", at(3)).changed).toBe(true);
    expect(store.resolveApproval("apr-1", 1, "approved", at(4)).changed).toBe(false);
    expect(() => store.resolveApproval("apr-1", 1, "denied", at(4))).toThrow("approval_conflict");
    store.createApproval({ approvalId: "apr-2", runId: "run-a1", actionType: "file_change", actionDigest: digest("f"), createdAt: at(5), expiresAt: at(6) });
    expect(() => store.resolveApproval("apr-2", 1, "approved", at(7))).toThrow("approval_expired");
    expect(store.expireApprovals("run-a1", "run_ended", at(8))).toBe(1);
    expect(store.getApproval("apr-2")?.status).toBe("expired");
    expect(JSON.stringify(store.replay(0, 100))).not.toContain("rm -rf");
    // One writer per project: a new key is refused while a run is active.
    expect(() => store.beginRun({ runId: "run-a2", sessionId: "ses-a", idempotencyKey: "key-a2", requestDigest: digest("b"), createdAt: at(9), exclusiveProject: "demo" })).toThrow("project_busy");
    expect(store.metrics(store.getRun("run-a1")!)).toMatchObject({ inputTokens: null, tokenScope: "not_measured", durationSource: "not_measured" });
    store.close();
  });
});

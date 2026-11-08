import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore, type SessionRecord } from "../src/runtime-store.ts";
import { activityEntry, approvalEntry, partialMessageEntry, redactSecrets, transcriptItemId, userMessageEntry, TRANSCRIPT_LIMITS } from "../src/transcript.ts";

/** E3.1 — persisted conversation: sanitization, schema v4 migration, deduplication, ordering, paging and retention. */
const base = await mkdtemp(join(tmpdir(), "cockpit-e31-store-"));
afterAll(async () => { await rm(base, { recursive: true, force: true }); });
const iso = (offsetSeconds: number) => new Date(Date.parse("2026-11-08T10:00:00.000Z") + offsetSeconds * 1000).toISOString();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const session = (id: string): SessionRecord => ({ sessionId: id, providerSessionId: `0b7f3c1e-0000-4000-8000-${id.replace(/\D/g, "").padStart(12, "0")}`,
  target: { provider: "claude", projectId: "alpha", vmName: "claude-alpha", vmInstanceId: null, discoveryVersion: iso(0) }, createdAt: iso(0), lastObservedAt: iso(0) });
let counter = 0;
async function store(limits = {}, now = iso(0)): Promise<{ store: RuntimeStore; path: string }> {
  const dir = join(base, `s${++counter}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "runtime.sqlite");
  return { store: new RuntimeStore(path, now, limits), path };
}
function run(s: RuntimeStore, sessionId: string, runId: string, status: "running" | "completed" | "interrupted" | null = "completed") {
  s.beginRun({ runId, sessionId, idempotencyKey: `key-${runId}`, requestDigest: digest(runId), createdAt: iso(1) });
  if (status === null) return;
  s.transition(runId, 1, "dispatching", iso(2));
  s.transition(runId, 2, "running", iso(3), { providerRunId: `turn-${runId}` });
  if (status !== "running") s.transition(runId, 3, status, iso(4));
}
const command = { id: "tool:toolu_1", kind: "command" as const, status: "completed" as const, text: "conteudo-do-arquivo SEGREDO", command: "cat .env", exitCode: 0, files: [], tool: "Bash" };

describe("E3.1 sanitization (what is stored)", () => {
  test("known credential shapes and secret assignments are redacted; ordinary text is untouched", () => {
    const cases: Array<[string, string]> = [
      ["use sk-ant-api03-abcdefghijklmnopqrstu please", "use [REDACTED] please"],
      ["export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123", "export GITHUB_TOKEN=[REDACTED]"],
      ["password: hunter2hunter2", "password: [REDACTED]"],
      ['{"api_key": "abcd1234efgh"}', '{"api_key": "[REDACTED]"}'],
      ["curl -H 'Authorization: Bearer abc.def.ghijklmnop'", "curl -H 'Authorization: Bearer [REDACTED]'"],
      ["git clone https://user:pa55word@example.com/repo.git", "git clone https://[REDACTED]@example.com/repo.git"],
      ["AKIAABCDEFGHIJKLMNOP", "[REDACTED]"],
      ["-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----", "[REDACTED]"],
    ];
    for (const [input, expected] of cases) expect(redactSecrets(input)).toBe(expected);
    expect(redactSecrets("Qual opção? Segurança. O token de sessão expira em 30 min.")).toBe("Qual opção? Segurança. O token de sessão expira em 30 min.");
  });

  test("tool output is never stored; inputs are reduced to command line and paths, bounded", () => {
    const entry = activityEntry(command, "completed")!;
    expect(entry.body).toEqual({ command: "cat .env", exitCode: 0, tool: "Bash", notice: null, outputOmitted: true });
    expect(JSON.stringify(entry)).not.toContain("SEGREDO");
    const grep = activityEntry({ id: "tool:2", kind: "tool", status: "completed", text: "linha com segredo", command: null, exitCode: null, files: [], tool: "Grep" }, "completed")!;
    expect(grep.body).toMatchObject({ tool: "Grep", text: null, outputOmitted: true });
    expect(activityEntry({ id: "tool:3", kind: "tool", status: "in_progress", text: "TODO", command: null, exitCode: null, files: [], tool: "Grep" }, "started")!.body.text).toBe("TODO");
    const files = activityEntry({ id: "f", kind: "file_change", status: "completed", text: null, command: null, exitCode: null, files: Array.from({ length: 80 }, (_, i) => `/w/${i}`), tool: "Write" }, "completed")!;
    expect(files.body.files).toHaveLength(TRANSCRIPT_LIMITS.files);
    expect(activityEntry({ id: "u", kind: "user_message", status: null, text: "x", command: null, exitCode: null, files: [] }, "completed")).toBeNull();
    const long = userMessageEntry("run-1", "a".repeat(TRANSCRIPT_LIMITS.message + 10));
    expect(long.body).toMatchObject({ truncated: true });
    expect(long.body.text).toHaveLength(TRANSCRIPT_LIMITS.message);
    expect(transcriptItemId("turn-1:msg_1:text")).toBe("turn-1:msg_1:text");
    expect(transcriptItemId("bad id/with spaces")).toMatch(/^h:[a-f0-9]{40}$/);
  });
});

describe("E3.1 RuntimeStore transcript", () => {
  test("an exact v3 database migrates to v4 additively in one transaction; rows are preserved; altered schemas stay refused", async () => {
    const { store: s, path } = await store();
    s.createSession(session("ses-1"));
    run(s, "ses-1", "run-1");
    s.recordUsage("run-1", { inputTokens: 3, outputTokens: 4 }, iso(5), "run");
    s.db.exec("DROP TABLE child_processes; DROP INDEX transcript_by_session; DROP TABLE transcript_items; PRAGMA user_version=3;");
    s.close();
    const migrated = new RuntimeStore(path, iso(10));
    expect((migrated.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(5); // v3 → v4 → v5
    expect(migrated.getRun("run-1")).toMatchObject({ status: "completed" });
    expect(migrated.metrics(migrated.getRun("run-1")!)).toMatchObject({ inputTokens: 3, tokenScope: "run" });
    expect(migrated.listSessions(["alpha"]).map(item => item.sessionId)).toEqual(["ses-1"]);
    migrated.recordTranscript("ses-1", "run-1", userMessageEntry("run-1", "oi"), iso(11));
    expect(migrated.transcriptPage("ses-1").items.map(item => item.text)).toEqual(["oi"]);
    migrated.db.exec("DROP TABLE child_processes; DROP INDEX transcript_by_session; DROP TABLE transcript_items; CREATE TABLE intruder (x TEXT); PRAGMA user_version=3;");
    migrated.close();
    expect(() => new RuntimeStore(path, iso(12))).toThrow("foreign_runtime_database_denied");
  });

  test("same item id updates in place (position kept); a completed item is never downgraded by a late partial", async () => {
    const { store: s } = await store();
    s.createSession(session("ses-1"));
    run(s, "ses-1", "run-1", "running");
    s.recordTranscript("ses-1", "run-1", userMessageEntry("run-1", "pergunta"), iso(5));
    s.recordTranscript("ses-1", "run-1", partialMessageEntry("turn-1:m1:text", "Res"), iso(6));
    s.recordTranscript("ses-1", "run-1", activityEntry({ ...command, status: "in_progress", text: null }, "started")!, iso(7));
    s.recordTranscript("ses-1", "run-1", partialMessageEntry("turn-1:m1:text", "Resposta par"), iso(8));
    let page = s.transcriptPage("ses-1");
    expect(page.items.map(item => [item.id, item.text ?? item.command])).toEqual([["run-1:prompt", "pergunta"], ["turn-1:m1:text", "Resposta par"], ["tool:toolu_1", "cat .env"]]);
    expect(page.items[1]!.incomplete).toBeUndefined(); // its run is still active: in progress, not incomplete
    s.recordTranscript("ses-1", "run-1", activityEntry({ id: "turn-1:m1:text", kind: "agent_message", status: "completed", text: "Resposta parcial completa", command: null, exitCode: null, files: [] }, "completed")!, iso(9));
    s.recordTranscript("ses-1", "run-1", partialMessageEntry("turn-1:m1:text", "Resposta par"), iso(10)); // late/duplicate partial
    s.recordTranscript("ses-1", "run-1", activityEntry(command, "completed")!, iso(11));
    page = s.transcriptPage("ses-1");
    expect(page.items).toHaveLength(3);
    expect(page.items[1]).toMatchObject({ text: "Resposta parcial completa", status: "completed" });
    expect(page.items[2]).toMatchObject({ status: "completed", command: "cat .env", outputOmitted: true });
  });

  test("partials of ended or restarted runs read as incomplete; approvals show the approvals table's status", async () => {
    const { store: s, path } = await store();
    s.createSession(session("ses-1"));
    run(s, "ses-1", "run-int", "interrupted");
    s.recordTranscript("ses-1", "run-int", partialMessageEntry("t1:m:text", "parcial"), iso(5));
    run(s, "ses-1", "run-live", "running");
    s.recordTranscript("ses-1", "run-live", partialMessageEntry("t2:m:text", "em curso"), iso(6));
    s.recordTranscript("ses-1", "run-live", activityEntry({ ...command, id: "tool:t2", status: "in_progress", text: null }, "started")!, iso(6));
    s.createApproval({ approvalId: "apr-1", runId: "run-live", actionType: "question", actionDigest: digest("q"), createdAt: iso(7), expiresAt: iso(3600) });
    s.recordTranscript("ses-1", "run-live", approvalEntry("apr-1", { actionType: "question", itemId: null, command: null, cwd: null, reason: null, files: [],
      questions: [{ question: "A ou B?", header: null, multiSelect: false, options: [] }] }), iso(7), "apr-1");
    expect(s.transcriptPage("ses-1").items.map(item => [item.id, item.incomplete ?? false, item.approval?.status ?? null])).toEqual([
      ["t1:m:text", true, null], ["t2:m:text", false, null], ["tool:t2", false, null], ["approval:apr-1", false, "pending"]]);
    s.close();
    // Restart: the live run becomes unknown and its pending approval expires; nothing is lost, everything unfinished says so.
    const restarted = new RuntimeStore(path, iso(20));
    const items = restarted.transcriptPage("ses-1").items;
    expect(items.map(item => [item.id, item.incomplete ?? false])).toEqual([["t1:m:text", true], ["t2:m:text", true], ["tool:t2", true], ["approval:apr-1", false]]);
    expect(items[3]!.approval).toMatchObject({ status: "expired", reasonCode: "process_restarted", questions: ["A ou B?"], answers: null });
    restarted.close();
  });

  test("paging is newest-first with an opaque cursor; bad cursors and limits are refused", async () => {
    const { store: s } = await store();
    s.createSession(session("ses-1"));
    s.createSession(session("ses-2"));
    run(s, "ses-1", "run-1");
    for (let i = 0; i < 7; i++) s.recordTranscript("ses-1", "run-1", userMessageEntry(`run-${i}x`, `m${i}`), iso(10 + i));
    s.recordTranscript("ses-2", null, userMessageEntry("other", "outra sessão"), iso(20));
    const first = s.transcriptPage("ses-1", undefined, 3);
    expect(first.items.map(item => item.text)).toEqual(["m4", "m5", "m6"]);
    const second = s.transcriptPage("ses-1", Number(first.nextCursor), 3);
    expect(second.items.map(item => item.text)).toEqual(["m1", "m2", "m3"]);
    const third = s.transcriptPage("ses-1", Number(second.nextCursor), 3);
    expect(third).toMatchObject({ nextCursor: null });
    expect(third.items.map(item => item.text)).toEqual(["m0"]);
    expect(() => s.transcriptPage("ses-1", 0)).toThrow("invalid_history_cursor");
    expect(() => s.transcriptPage("ses-1", undefined, 501)).toThrow("invalid_limit");
    expect(() => s.recordTranscript("ses-1", null, { ...userMessageEntry("r", "x"), itemId: "bad id" }, iso(30))).toThrow("invalid_transcript_item");
    expect(() => s.recordTranscript("ses-missing", null, userMessageEntry("r", "x"), iso(30))).toThrow(); // foreign key: no orphan rows
  });

  test("retention: per-session cap, global cap and age limit drop the oldest items only", async () => {
    const { store: s, path } = await store({ maxItemsPerSession: 5, maxItems: 8, retentionDays: 30 });
    s.createSession(session("ses-1"));
    s.createSession(session("ses-2"));
    for (let i = 0; i < 7; i++) s.recordTranscript("ses-1", null, userMessageEntry(`a${i}`, `a${i}`), iso(i));
    expect(s.transcriptPage("ses-1").items.map(item => item.text)).toEqual(["a2", "a3", "a4", "a5", "a6"]);
    const recent = 31 * 86_400;
    for (let i = 0; i < 5; i++) s.recordTranscript("ses-2", null, userMessageEntry(`b${i}`, `b${i}`), iso(recent + i));
    s.close();
    const limits = { maxItemsPerSession: 5, maxItems: 8, retentionDays: 30 };
    // Startup applies the global cap: 10 items > 8, the two oldest of the whole store go.
    const capped = new RuntimeStore(path, iso(10), limits);
    expect(capped.transcriptPage("ses-1").items.map(item => item.text)).toEqual(["a4", "a5", "a6"]);
    expect(capped.transcriptPage("ses-2").items).toHaveLength(5);
    capped.close();
    // A later startup applies the age limit (30 days): only ses-1's old items go.
    const later = new RuntimeStore(path, iso(recent + 100), limits);
    expect(later.transcriptPage("ses-1").items).toEqual([]);
    expect(later.transcriptPage("ses-2").items.map(item => item.text)).toEqual(["b0", "b1", "b2", "b3", "b4"]);
    later.close();
    expect(() => new RuntimeStore(path, iso(0), { pageSize: 0 })).toThrow("invalid_transcript_limits");
  });

  test("a corrupt stored body is reported as corruption, never rendered", async () => {
    const { store: s } = await store();
    s.createSession(session("ses-1"));
    s.recordTranscript("ses-1", null, userMessageEntry("r", "ok"), iso(1));
    s.db.exec("UPDATE transcript_items SET body_json='[1,2]'");
    expect(() => s.transcriptPage("ses-1")).toThrow("runtime_database_corrupt");
  });
});

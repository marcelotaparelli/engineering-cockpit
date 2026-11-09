import { describe, expect, test } from "bun:test";
import { agentChars, blockersOf, code, countRuns, hasEnoughPartial, judgeBlockedSend, judgePartialPreserved, judgeReconcileAfterRelease, judgeReconcileWhileOwnerAlive, MIN_PARTIAL_CHARS,
  parseOrphans, parseReconcile, parseRunTranscript, type ReconcileView, type RunTranscript } from "../src/f2-proof.ts";

/** F2-M2 — the pure parsers and verdicts of the provider proof: every branch, and hostile or malformed input. */
const RUN = "run-1";
const page = (...items: Array<Record<string, unknown>>) => ({ items });
const agent = (text: string, extra: Record<string, unknown> = {}) => ({ id: "msg_1", runId: RUN, kind: "agent_message", status: "in_progress", text, ...extra });
const user = (id = "u1") => ({ id, runId: RUN, kind: "user_message", status: null, text: "prompt" });
const transcript = (body: unknown): RunTranscript => parseRunTranscript(body, RUN)!;
const view = (over: Partial<ReconcileView> = {}): ReconcileView => ({ http: 200, status: "unknown", result: "unconfirmed", reason: "provider_cannot_confirm", errorCode: null, ...over });
const long = "x".repeat(MIN_PARTIAL_CHARS);

describe("closed vocabulary", () => {
  test("only [a-z0-9_] codes pass; anything else is dropped so a surprise string can never reach a report", () => {
    expect(code("orphan_owns_turn")).toBe("orphan_owns_turn");
    for (const bad of ["Orphan", "has space", "x\nSECRET", "a".repeat(65), "", 7, null, undefined, {}, "9starts_with_digit", "ação"]) expect(code(bad)).toBeNull();
  });
});

describe("transcript", () => {
  test("a history page is read per run: other runs, malformed items and non-string text are tolerated", () => {
    const t = transcript(page(user(), agent("abc"), { ...agent("other run"), runId: "run-2", id: "z" }, { kind: "agent_message", runId: RUN }, "not an object" as never, { ...agent(42 as never), id: "msg_2" }));
    expect([...t.agentItems.keys()]).toEqual(["msg_1", "msg_2"]);
    expect(t.agentItems.get("msg_2")!.text).toBe("");
    expect(t.userMessages).toBe(1);
    expect(agentChars(t)).toBe(3);
  });
  test("not a history page → null (the smoke then reports the history as unreadable, it never invents one)", () => {
    for (const body of [null, "x", 7, [], {}, { items: "no" }, { items: null }]) expect(parseRunTranscript(body, RUN)).toBeNull();
  });
  test("enough partial text means an IN-PROGRESS message of at least MIN_PARTIAL_CHARS", () => {
    expect(hasEnoughPartial(null)).toBe(false);
    expect(hasEnoughPartial(transcript(page(agent("x".repeat(MIN_PARTIAL_CHARS - 1)))))).toBe(false);
    expect(hasEnoughPartial(transcript(page(agent(long))))).toBe(true);
    expect(hasEnoughPartial(transcript(page(agent(long, { status: "completed" }))))).toBe(false);
  });
});

describe("partial preserved", () => {
  const before = transcript(page(user(), agent(long)));
  test("the restarted history holding the same text (or more), marked incomplete, with one prompt, passes; evidence has only counts", () => {
    const verdict = judgePartialPreserved(before, transcript(page(user(), agent(long + " e mais um pouco", { incomplete: true }))));
    expect(verdict).toMatchObject({ status: "PASS", reason: null, evidence: { items: 1, chars_before: MIN_PARTIAL_CHARS, prefix_preserved: true, marked_incomplete: true, user_messages: 1 } });
    expect(JSON.stringify(verdict)).not.toContain("xxxx");
    expect(judgePartialPreserved(before, transcript(page(user(), agent(long, { incomplete: true })))).status).toBe("PASS"); // equal length: nothing flushed in between
  });
  const cases: Array<[string, RunTranscript | null, string]> = [
    ["unreadable", null, "history_unreadable_after_restart"],
    ["item gone", transcript(page(user())), "partial_item_missing_after_restart"],
    ["shorter", transcript(page(user(), agent(long.slice(1), { incomplete: true }))), "partial_text_changed_after_restart"],
    ["rewritten", transcript(page(user(), agent("y" + long.slice(1), { incomplete: true }))), "partial_text_changed_after_restart"],
    ["not marked incomplete", transcript(page(user(), agent(long))), "partial_not_marked_incomplete"],
    ["prompt twice", transcript(page(user(), user("u2"), agent(long, { incomplete: true }))), "prompt_not_exactly_once"],
    ["prompt gone", transcript(page(agent(long, { incomplete: true }))), "prompt_not_exactly_once"],
  ];
  for (const [name, after, reason] of cases) test(`FAIL when ${name}`, () => expect(judgePartialPreserved(before, after)).toMatchObject({ status: "FAIL", reason }));
  test("a `before` without any streaming item proves nothing about incompleteness: FAIL, not a silent PASS", () => {
    const done = transcript(page(user(), agent(long, { status: "completed" })));
    expect(judgePartialPreserved(done, transcript(page(user(), agent(long, { status: "completed" }))))).toMatchObject({ status: "FAIL", reason: "no_streaming_item_to_mark_incomplete" });
  });
});

describe("orphans", () => {
  const item = (over: Record<string, unknown> = {}) => ({ kind: "orphan_process", pid: 42, vm_name: "claude-a", process_kind: "claude_session", blocks: "session", session_id: "ses-1", ...over });
  test("only orphan items with an integer PID are read; odd kinds become `unknown`", () => {
    expect(parseOrphans({ attention: [item(), { kind: "unknown_run", pid: 1 }, item({ pid: "42" }), item({ pid: 1.5 }), item({ pid: 7, process_kind: "Weird Kind", blocks: "x y" }), "str"] }))
      .toEqual([{ pid: 42, vm: "claude-a", kind: "claude_session", blocks: "session", sessionId: "ses-1" }, { pid: 7, vm: "claude-a", kind: "unknown", blocks: "unknown", sessionId: "ses-1" }]);
    for (const body of [null, {}, { attention: "no" }]) expect(parseOrphans(body)).toBeNull();
  });
  test("blockers: Codex = an app-server of THAT VM; Claude = a claude_session of THAT session; only listed survivors; a one-shot command blocks nothing", () => {
    const all = parseOrphans({ attention: [item({ pid: 1 }), item({ pid: 2, session_id: "ses-2" }), item({ pid: 3, process_kind: "claude_command", blocks: "nothing" }),
      item({ pid: 4, process_kind: "codex_app_server", blocks: "vm", vm_name: "codex-a", session_id: null }), item({ pid: 5, process_kind: "codex_app_server", blocks: "vm", vm_name: "codex-b", session_id: null })] })!;
    expect(blockersOf(all, "claude", "claude-a", "ses-1", [1, 2, 3, 4, 5]).map(o => o.pid)).toEqual([1]);
    expect(blockersOf(all, "claude", "claude-a", "ses-1", [2, 3])).toEqual([]);
    expect(blockersOf(all, "codex", "codex-a", "ses-1", [1, 2, 3, 4, 5]).map(o => o.pid)).toEqual([4]);
    expect(blockersOf(all, "codex", "codex-a", "ses-1", [])).toEqual([]);
  });
});

describe("blocked send", () => {
  test("409 orphan_process_alive and exactly one run in the session passes", () => {
    expect(judgeBlockedSend({ status: 409, body: { error: { code: "orphan_process_alive" } } }, 1)).toMatchObject({ status: "PASS" });
  });
  test("any other answer fails, with the status and code in the reason", () => {
    expect(judgeBlockedSend({ status: 202, body: { run_id: "r" } }, 2)).toMatchObject({ status: "FAIL", reason: "send_not_blocked_202_no_code" });
    expect(judgeBlockedSend({ status: 409, body: { error: { code: "project_busy" } } }, 1)).toMatchObject({ status: "FAIL", reason: "send_not_blocked_409_project_busy" });
    expect(judgeBlockedSend({ status: 500, body: "boom" }, 1)).toMatchObject({ status: "FAIL", reason: "send_not_blocked_500_no_code" });
  });
  test("a refused send that left a second run is a FAIL; an unreadable run count is NOT_VERIFIED, never a claim either way", () => {
    expect(judgeBlockedSend({ status: 409, body: { error: { code: "orphan_process_alive" } } }, 2)).toMatchObject({ status: "FAIL", reason: "blocked_send_created_a_run" });
    expect(judgeBlockedSend({ status: 409, body: { error: { code: "orphan_process_alive" } } }, null)).toMatchObject({ status: "NOT_VERIFIED", reason: "session_runs_unreadable_after_blocked_send" });
    expect(countRuns({ runs: [{}, {}] })).toBe(2);
    for (const body of [null, {}, { runs: "x" }]) expect(countRuns(body)).toBeNull();
  });
});

describe("reconcile", () => {
  test("parsing keeps only closed codes, whatever the wire says", () => {
    expect(parseReconcile({ status: 200, body: { status: "unknown", reconciliation: { result: "unconfirmed", reason_code: "orphan_owns_turn" } } })).toEqual({ http: 200, status: "unknown", result: "unconfirmed", reason: "orphan_owns_turn", errorCode: null });
    const hostile = parseReconcile({ status: 200, body: { status: "SECRET status", reconciliation: { result: "x y", reason_code: "Has Spaces & SECRET" } } });
    expect(hostile).toEqual({ http: 200, status: null, result: null, reason: null, errorCode: null });
    expect(parseReconcile({ status: 409, body: { error: { code: "project_busy" } } })).toMatchObject({ http: 409, errorCode: "project_busy", status: null });
    expect(parseReconcile({ status: 502, body: "<html>" })).toEqual({ http: 502, status: null, result: null, reason: null, errorCode: null });
  });

  describe("while the owner may live", () => {
    test("Codex needs orphan_owns_turn, Claude needs provider_cannot_confirm; both need 200, unknown, unconfirmed and no new msb exec child", () => {
      expect(judgeReconcileWhileOwnerAlive("claude", view(), 0)).toMatchObject({ status: "PASS" });
      expect(judgeReconcileWhileOwnerAlive("codex", view({ reason: "orphan_owns_turn" }), 0)).toMatchObject({ status: "PASS" });
      expect(judgeReconcileWhileOwnerAlive("codex", view(), 0)).toMatchObject({ status: "FAIL", reason: "reconcile_not_conservative" }); // the wrong provider's reason
      expect(judgeReconcileWhileOwnerAlive("claude", view({ reason: "orphan_owns_turn" }), 0)).toMatchObject({ status: "FAIL", reason: "reconcile_not_conservative" });
    });
    for (const [name, over] of [["http error", { http: 409, errorCode: "project_busy" }], ["run resolved", { status: "completed", result: "confirmed", reason: "reconciled" }], ["reattached", { status: "running", result: "confirmed", reason: "reconciled" }],
      ["no codes", { status: null, result: null, reason: null }]] as Array<[string, Partial<ReconcileView>]>) {
      test(`FAIL when ${name}`, () => expect(judgeReconcileWhileOwnerAlive("claude", view(over), 0)).toMatchObject({ status: "FAIL", reason: "reconcile_not_conservative" }));
    }
    test("an `msb exec` child opened by the reconcile fails it even when the answer is right", () => {
      expect(judgeReconcileWhileOwnerAlive("claude", view(), 1)).toMatchObject({ status: "FAIL", reason: "reconcile_spawned_msb_exec_child", evidence: { new_msb_exec_children: 1 } });
    });
  });

  describe("after the owner ended", () => {
    test("Claude must still not confirm: anything but unknown/provider_cannot_confirm fails, and a resolved run is named as such", () => {
      expect(judgeReconcileAfterRelease("claude", view(), true)).toMatchObject({ status: "PASS" });
      expect(judgeReconcileAfterRelease("claude", view({ status: "completed", result: "confirmed", reason: "reconciled" }), true)).toMatchObject({ status: "FAIL", reason: "claude_run_resolved_without_evidence" });
      expect(judgeReconcileAfterRelease("claude", view({ http: 500 }), true)).toMatchObject({ status: "FAIL", reason: "reconcile_not_conservative" });
      expect(judgeReconcileAfterRelease("claude", view({ reason: "provider_reports_unknown" }), true)).toMatchObject({ status: "FAIL", reason: "reconcile_not_conservative" });
    });
    const codex = (over: Partial<ReconcileView>, orphan = true) => judgeReconcileAfterRelease("codex", view({ reason: "provider_reports_unknown", ...over }), orphan);
    test("Codex's answer is observed: terminal statuses and an unconfirmed unknown pass, with the orphan's existence recorded", () => {
      for (const status of ["completed", "failed", "interrupted"]) expect(codex({ status, result: "confirmed", reason: "reconciled" })).toMatchObject({ status: "PASS", evidence: { run_status: status, orphan_existed: true } });
      expect(codex({})).toMatchObject({ status: "PASS" });
      expect(codex({}, false)).toMatchObject({ status: "PASS", evidence: { orphan_existed: false } });
    });
    test("a turn still running is the open L4 case: NOT_VERIFIED (never PASS, never FAIL); a refusal that outlives the orphan is a FAIL", () => {
      expect(codex({ status: "running", result: "confirmed", reason: "reconciled" })).toMatchObject({ status: "NOT_VERIFIED", reason: "reattached_running_after_owner_ended" });
      expect(codex({ reason: "orphan_owns_turn" })).toMatchObject({ status: "FAIL", reason: "orphan_still_owns_turn_after_release" });
    });
    test("an error from the Cockpit means nothing was observed (NOT_VERIFIED); an impossible combination is a FAIL", () => {
      expect(codex({ http: 409, errorCode: "project_busy", status: null, result: null, reason: null })).toMatchObject({ status: "NOT_VERIFIED", reason: "reconcile_http_409_project_busy" });
      expect(codex({ http: 502, errorCode: null, status: null, result: null, reason: null })).toMatchObject({ status: "NOT_VERIFIED", reason: "reconcile_http_502_no_code" });
      expect(codex({ status: "completed", result: "unconfirmed", reason: "x" })).toMatchObject({ status: "FAIL", reason: "reconcile_after_release_unexpected" });
      expect(codex({ status: null, result: null, reason: null })).toMatchObject({ status: "FAIL", reason: "reconcile_after_release_unexpected" });
    });
  });
});

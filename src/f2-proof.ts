/**
 * F2 — the provider-proof verdicts of the isolated smoke (`src/f1-systemd-smoke.ts`), as PURE functions: no I/O, no clock, no
 * processes. The smoke asks the Cockpit's HTTP API and hands the answers here; keeping the judgement apart makes every branch
 * testable without systemd, and lets a contract test run the very same parsers against the real server.
 *
 * What the proof asserts after a real turn is in flight and the Cockpit is killed (SIGKILL) and restarted by systemd:
 *  - the in-flight run is `unknown`, never promoted to a result without provider evidence (D3);
 *  - Claude: the partial answer the Cockpit had persisted before the kill is still there, untouched at its start, and marked
 *    incomplete; the prompt exists exactly once (nothing resent);
 *  - the surviving `msb exec` child is listed as an orphan, and while it lives a new send to that session/VM is refused (409)
 *    without creating a run;
 *  - a reconcile while it lives is conservative and contacts nothing: Codex `orphan_owns_turn`, Claude `provider_cannot_confirm`;
 *  - after the orphan ended, the block is gone from the Cockpit's own view and a reconcile is still conservative for Claude,
 *    and merely OBSERVED for Codex (what the real provider says about a turn whose owner died is the open L4 / P3 question).
 *
 * Nothing here ever keeps provider text: evidence holds lengths, counts, booleans and closed-vocabulary codes.
 */

export type ProofProvider = "codex" | "claude";
export type Verdict = { status: "PASS" | "FAIL" | "NOT_VERIFIED"; reason: string | null; evidence: Record<string, unknown> };
export interface ProofResponse { status: number; body: unknown }
export interface ProofHttp { get(path: string): Promise<ProofResponse>; post(path: string, payload: unknown, headers?: Record<string, string>): Promise<ProofResponse> }

/** One real turn, no tools, long enough to still be running when the Cockpit is killed. Never repeated in evidence. */
export const CLAUDE_PROOF_PROMPT = "Teste automatizado F2, sem usar ferramentas: escreva 300 linhas numeradas, cada uma com uma frase curta sobre o mar.";
/** A partial answer shorter than this proves little; the smoke waits for at least this much text to be persisted before it kills. */
export const MIN_PARTIAL_CHARS = 80;

const object = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** Closed vocabulary only (`[a-z0-9_]`): anything else from the wire is replaced, so a surprise string never reaches a report. */
export function code(value: unknown): string | null { return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null; }
const errorCode = (body: unknown): string | null => code(object(object(body)?.error)?.code);

// ------------------------------------------------------------------------------------------------ transcript (partial output)
export interface AgentItem { text: string; inProgress: boolean; incomplete: boolean }
export interface RunTranscript { agentItems: Map<string, AgentItem>; userMessages: number }

/** `GET /api/sessions/:id/history` → what the persisted history holds for ONE run. Null when the body is not a history page. */
export function parseRunTranscript(body: unknown, runId: string): RunTranscript | null {
  const items = object(body)?.items;
  if (!Array.isArray(items)) return null;
  const transcript: RunTranscript = { agentItems: new Map(), userMessages: 0 };
  for (const raw of items) {
    const item = object(raw);
    if (!item || item.runId !== runId || typeof item.id !== "string") continue;
    if (item.kind === "user_message") transcript.userMessages++;
    else if (item.kind === "agent_message") transcript.agentItems.set(item.id, { text: typeof item.text === "string" ? item.text : "", inProgress: item.status === "in_progress", incomplete: item.incomplete === true });
  }
  return transcript;
}
export async function readRunTranscript(http: ProofHttp, sessionId: string, runId: string): Promise<RunTranscript | null> {
  const response = await http.get(`api/sessions/${encodeURIComponent(sessionId)}/history?limit=500`);
  return response.status === 200 ? parseRunTranscript(response.body, runId) : null;
}
export function agentChars(transcript: RunTranscript): number { let total = 0; for (const item of transcript.agentItems.values()) total += item.text.length; return total; }
/** True once an in-progress agent message holds enough persisted text to make the preservation check meaningful. */
export function hasEnoughPartial(transcript: RunTranscript | null): boolean {
  if (!transcript) return false;
  for (const item of transcript.agentItems.values()) if (item.inProgress && item.text.length >= MIN_PARTIAL_CHARS) return true;
  return false;
}

/**
 * `before`: read while the run was live. `after`: read after the kill and the restart. Every item seen before must still be
 * there with its text as a PREFIX (a flush may have landed between the read and the kill, so it can only have grown), the item
 * that was still streaming must now be marked incomplete, and the prompt must exist exactly once. Evidence never carries text.
 */
export function judgePartialPreserved(before: RunTranscript, after: RunTranscript | null): Verdict {
  const fail = (reason: string, evidence: Record<string, unknown> = {}): Verdict => ({ status: "FAIL", reason, evidence });
  if (!after) return fail("history_unreadable_after_restart");
  let markedIncomplete = false;
  for (const [id, was] of before.agentItems) {
    const now = after.agentItems.get(id);
    if (!now) return fail("partial_item_missing_after_restart", { chars_before: agentChars(before) });
    if (!now.text.startsWith(was.text)) return fail("partial_text_changed_after_restart", { chars_before: was.text.length, chars_after: now.text.length });
    if (was.inProgress) { if (!now.incomplete) return fail("partial_not_marked_incomplete", { chars_before: was.text.length, chars_after: now.text.length }); markedIncomplete = true; }
  }
  if (!markedIncomplete) return fail("no_streaming_item_to_mark_incomplete");
  if (after.userMessages !== 1) return fail("prompt_not_exactly_once", { user_messages: after.userMessages });
  return { status: "PASS", reason: null, evidence: { items: before.agentItems.size, chars_before: agentChars(before), chars_after: agentChars(after), prefix_preserved: true, marked_incomplete: true, user_messages: 1 } };
}

// ------------------------------------------------------------------------------------------------ orphans (dashboard attention)
export interface OrphanView { pid: number; vm: string; kind: string; blocks: string; sessionId: string | null }
/** `GET /api/dashboard` → the `orphan_process` attention items. Null when the body has no attention list. */
export function parseOrphans(body: unknown): OrphanView[] | null {
  const attention = object(body)?.attention;
  if (!Array.isArray(attention)) return null;
  const orphans: OrphanView[] = [];
  for (const raw of attention) {
    const item = object(raw);
    if (!item || item.kind !== "orphan_process" || !Number.isSafeInteger(item.pid)) continue;
    orphans.push({ pid: item.pid as number, vm: typeof item.vm_name === "string" ? item.vm_name : "", kind: code(item.process_kind) ?? "unknown", blocks: code(item.blocks) ?? "unknown",
      sessionId: typeof item.session_id === "string" ? item.session_id : null });
  }
  return orphans;
}
/** The orphans that forbid a new send to the proof session: a Claude process of THAT session, or a Codex app-server of THAT VM. */
export function blockersOf(orphans: readonly OrphanView[], provider: ProofProvider, vm: string, sessionId: string, survivors: readonly number[]): OrphanView[] {
  return orphans.filter(orphan => survivors.includes(orphan.pid) &&
    (provider === "codex" ? orphan.kind === "codex_app_server" && orphan.vm === vm : orphan.kind === "claude_session" && orphan.sessionId === sessionId));
}

// ------------------------------------------------------------------------------------------------ blocked send
/** The probe send while a blocking orphan lives: refused with 409 `orphan_process_alive`, and no run row was created for it. */
export function judgeBlockedSend(response: ProofResponse, runsAfter: number | null): Verdict {
  const found = errorCode(response.body);
  if (response.status !== 409 || found !== "orphan_process_alive") {
    return { status: "FAIL", reason: `send_not_blocked_${response.status}_${found ?? "no_code"}`, evidence: { status: response.status } };
  }
  // Unreadable is not "a run was created": nothing was observed, so nothing is claimed either way.
  if (runsAfter === null) return { status: "NOT_VERIFIED", reason: "session_runs_unreadable_after_blocked_send", evidence: { status: 409 } };
  if (runsAfter !== 1) return { status: "FAIL", reason: "blocked_send_created_a_run", evidence: { status: 409, runs_in_session: runsAfter } };
  return { status: "PASS", reason: null, evidence: { status: 409, error_code: "orphan_process_alive", runs_in_session: 1 } };
}
export function countRuns(body: unknown): number | null {
  const runs = object(body)?.runs;
  return Array.isArray(runs) ? runs.length : null;
}

// ------------------------------------------------------------------------------------------------ reconcile
export interface ReconcileView { http: number; status: string | null; result: string | null; reason: string | null; errorCode: string | null }
export function parseReconcile(response: ProofResponse): ReconcileView {
  const body = object(response.body);
  const reconciliation = object(body?.reconciliation);
  return { http: response.status, status: code(body?.status), result: code(reconciliation?.result), reason: code(reconciliation?.reason_code), errorCode: errorCode(response.body) };
}
const observed = (view: ReconcileView) => ({ http: view.http, run_status: view.status, result: view.result, reason_code: view.reason, error_code: view.errorCode });
const EXPECTED_WHILE_OWNER_ALIVE: Readonly<Record<ProofProvider, string>> = { codex: "orphan_owns_turn", claude: "provider_cannot_confirm" };
/** Answers that say the Cockpit could not even reach the question (no provider run id, ledger unreadable): nothing was observed about the owner. */
const NOT_OBSERVED_REASONS: ReadonlySet<string> = new Set(["provider_run_unbound", "orphan_check_unavailable"]);

/** The Cockpit's own counters (`GET /api/dashboard` → `reliability`): what the reconcile must NOT have moved. Null when absent. */
export interface Reliability { providerConnections: number; runsDispatched: number }
export function parseReliability(body: unknown): Reliability | null {
  const reliability = object(object(body)?.reliability);
  const connections = reliability?.provider_connections; const dispatched = reliability?.runs_dispatched;
  return Number.isSafeInteger(connections) && Number.isSafeInteger(dispatched) ? { providerConnections: connections as number, runsDispatched: dispatched as number } : null;
}
/** What was watched while the reconcile ran. `unreadableChildren`: new `msb` processes whose argv could not be read, so they could not be classified. */
export interface ReconcileWatch { newExecChildren: number; unreadableChildren: number; before: Reliability | null; after: Reliability | null; orphanAlive: boolean }

/**
 * The reconcile asked while the surviving process may still own the turn. Conservative means: HTTP 200, the run still `unknown`,
 * `unconfirmed` with the documented reason, and NOTHING OPENED BESIDE THE OWNER, observed two ways: the Cockpit's own counters
 * (no new provider connection, no prompt dispatched: race-free) and the unit's cgroup sampled during the call (no new `msb exec`
 * child: a child that lives and dies between samples can slip through, which is why the counters exist). PASS needs both
 * observations complete; anything less is NOT_VERIFIED, never a PASS for lack of evidence.
 */
export function judgeReconcileWhileOwnerAlive(provider: ProofProvider, view: ReconcileView, watch: ReconcileWatch): Verdict {
  const expected = EXPECTED_WHILE_OWNER_ALIVE[provider];
  const evidence = { ...observed(view), expected_reason_code: expected, orphan_alive: watch.orphanAlive, new_msb_exec_children: watch.newExecChildren, unreadable_new_msb_children: watch.unreadableChildren,
    provider_connections_before: watch.before?.providerConnections ?? null, provider_connections_after: watch.after?.providerConnections ?? null };
  if (view.result === "unconfirmed" && view.reason !== null && NOT_OBSERVED_REASONS.has(view.reason)) return { status: "NOT_VERIFIED", reason: `reconcile_${view.reason}`, evidence };
  if (view.http !== 200 || view.status !== "unknown" || view.result !== "unconfirmed" || view.reason !== expected) return { status: "FAIL", reason: "reconcile_not_conservative", evidence };
  if (watch.newExecChildren > 0) return { status: "FAIL", reason: "reconcile_spawned_msb_exec_child", evidence };
  if (watch.before && watch.after && watch.after.providerConnections > watch.before.providerConnections) return { status: "FAIL", reason: "reconcile_opened_provider_connection", evidence };
  if (watch.before && watch.after && watch.after.runsDispatched > watch.before.runsDispatched) return { status: "FAIL", reason: "reconcile_dispatched_a_run", evidence };
  if (watch.unreadableChildren > 0 || !watch.before || !watch.after) return { status: "NOT_VERIFIED", reason: "child_observation_incomplete", evidence };
  return { status: "PASS", reason: null, evidence };
}

/**
 * The reconcile asked after the surviving process ended.
 *  - Claude can never confirm a turn after a restart: it must stay `unknown`/`provider_cannot_confirm`. Anything else would be a
 *    run resolved without evidence, which is a FAIL.
 *  - Codex asks the real provider, and the answer is OBSERVED, not prescribed: a terminal status or an unconfirmed `unknown` is a
 *    PASS (nothing resent, nothing guessed); a turn still reading `running` is the open L4 case (the run reattaches to a stream
 *    that may never deliver) and is reported NOT_VERIFIED so the operator brings the evidence to question P3.
 */
export function judgeReconcileAfterRelease(provider: ProofProvider, view: ReconcileView, orphanExisted: boolean): Verdict {
  const evidence = { ...observed(view), orphan_existed: orphanExisted };
  if (view.result === "unconfirmed" && view.reason !== null && NOT_OBSERVED_REASONS.has(view.reason)) return { status: "NOT_VERIFIED", reason: `reconcile_${view.reason}`, evidence };
  if (provider === "claude") {
    if (view.http === 200 && view.status === "unknown" && view.result === "unconfirmed" && view.reason === "provider_cannot_confirm") return { status: "PASS", reason: null, evidence };
    if (view.http === 200 && view.status !== null && view.status !== "unknown") return { status: "FAIL", reason: "claude_run_resolved_without_evidence", evidence };
    return { status: "FAIL", reason: "reconcile_not_conservative", evidence };
  }
  if (view.http !== 200) return { status: "NOT_VERIFIED", reason: `reconcile_http_${view.http}_${view.errorCode ?? "no_code"}`, evidence };
  if (view.result === "unconfirmed" && view.reason === "orphan_owns_turn") return { status: "FAIL", reason: "orphan_still_owns_turn_after_release", evidence };
  if (view.result === "confirmed" && (view.status === "completed" || view.status === "failed" || view.status === "interrupted")) return { status: "PASS", reason: null, evidence };
  if (view.result === "unconfirmed" && view.status === "unknown" && view.reason === "provider_reports_unknown") return { status: "PASS", reason: null, evidence };
  if (view.result === "confirmed" && view.status === "running") return { status: "NOT_VERIFIED", reason: "reattached_running_after_owner_ended", evidence };
  return { status: "FAIL", reason: "reconcile_after_release_unexpected", evidence };
}

import { randomUUID } from "node:crypto";
import { readHostVmList } from "./adapter.ts";
import { assertArchHost, hostFacts, type HostFacts } from "./host.ts";
import { SafeError, safeCode } from "./model.ts";
import { minimalChildEnv, type MsbChild, type MsbSpawn } from "./msb-transport.ts";
import { parseVmInventory } from "./parser.ts";
import { assertRuntime } from "./runtime.ts";
import { assertClaudeTarget, claudeStreamArgv, interruptRequest, probeCapabilities, questionAnswer, toolDecision, userMessage, type Capabilities, type ClaudeEvent } from "./claude-protocol.ts";
import { ClaudeStreamProcess, execClaudeOnce, type ExitReport } from "./claude-process.ts";

/**
 * E2 spike: proves (or refuses to prove) Claude Code control over `msb exec --stream` + `claude -p` stream-json
 * in ONE exclusive test VM. Read-only checks run with the base consent; anything that sends a prompt (consumes quota)
 * needs the second consent. The report carries booleans, counts, enum tags and the CLI version only — never prompt,
 * response, command, path, id, e-mail or organisation values.
 */
export type SpikeStatus = "PASS" | "FAIL" | "NOT_VERIFIED" | "INCONCLUSIVE";
export const CHECK_IDS = ["runtime", "host_consent", "target_running", "version", "capabilities", "auth_state",
  "streaming_turn", "multi_turn_same_process", "interrupt", "approval_reject", "question_answer", "process_exit", "resume", "error_classification"] as const;
export type CheckId = typeof CHECK_IDS[number];
export interface SpikeCheck { id: CheckId; status: SpikeStatus; reason: string | null; duration_ms: number; evidence?: Record<string, string | number | boolean | null> }
export interface SpikeReport { milestone: "E2-spike"; source: "host" | "synthetic"; timestamp: string; overall: SpikeStatus; real_prompts: boolean; claude_version: string | null; checks: SpikeCheck[] }
export interface SpikeOverrides {
  facts: HostFacts; env: Record<string, string | undefined>; readOutput: () => Promise<string>; spawn: MsbSpawn;
  turnTimeoutMs?: number; graceMs?: number;
}

const MEMO = "ABACATE";
const PROMPTS = {
  remember: `Remember ${MEMO} and reply only with OK.`,
  recall: "Recall the word I asked you to remember. Reply with only that word.",
  long: "Write a very slow and detailed 3000 word essay about the history of computing.",
  approval: "Use the Bash tool to run exactly this command and nothing else: touch /tmp/e2-approval-probe. I want to approve it first.",
  question: "Use the AskUserQuestion tool to ask me to choose between A and B, then reply with only my choice.",
} as const;

const nativeSpawn: MsbSpawn = (argv, options) => { assertArchHost(); return Bun.spawn([...argv], options) as unknown as MsbChild; };

const execOnce = (spawn: MsbSpawn, vm: string, command: string[], timeoutMs: number) => execClaudeOnce(spawn, vm, command, timeoutMs).catch(error => {
  throw error instanceof SafeError && error.code === "claude_command_timeout" ? new SafeError("e2_command_timeout") : error instanceof SafeError && error.code === "claude_output_limit" ? new SafeError("e2_output_limit") : error;
});

export async function runClaudeSpike(overrides?: SpikeOverrides): Promise<SpikeReport> {
  const checks: SpikeCheck[] = CHECK_IDS.map(id => ({ id, status: "NOT_VERIFIED", reason: "not_exercised", duration_ms: 0 }));
  const env = overrides?.env ?? process.env;
  const report: SpikeReport = { milestone: "E2-spike", source: overrides ? "synthetic" : "host", timestamp: new Date().toISOString(), overall: "NOT_VERIFIED",
    real_prompts: env.COCKPIT_E2_REAL_PROMPTS === "yes", claude_version: null, checks };
  const set = (id: CheckId, status: SpikeStatus, reason: string | null, started: number, evidence?: SpikeCheck["evidence"]): void => {
    Object.assign(checks.find(row => row.id === id)!, { status, reason, duration_ms: Math.max(0, Date.now() - started), ...(evidence ? { evidence } : {}) });
  };
  const finalize = (): SpikeReport => {
    report.overall = checks.some(check => check.status === "FAIL") ? "FAIL"
      : checks.every(check => check.status === "PASS" || check.id === "error_classification") ? "PASS" : "NOT_VERIFIED";
    return report;
  };
  const spawn = overrides?.spawn ?? nativeSpawn;
  const turnTimeout = overrides?.turnTimeoutMs ?? 90_000;
  const grace = overrides?.graceMs ?? 3000;
  let started = Date.now();

  try { assertRuntime(); set("runtime", "PASS", null, started); }
  catch (error) { set("runtime", "FAIL", safeCode(error), started); return finalize(); }

  // Consent, host and target. Nothing below runs unless every gate passes; no VM is ever started or created.
  started = Date.now();
  let vm: string;
  try {
    assertArchHost(env, overrides?.facts ?? hostFacts());
    if (env.COCKPIT_E2_CONFIRMED !== "yes") throw new SafeError("e2_confirmation_required");
    if (!env.COCKPIT_E2_VM) throw new SafeError("e2_target_required");
    vm = env.COCKPIT_E2_VM;
    assertClaudeTarget(vm);
    if (!/^claude-cockpit-e2[a-z0-9_-]*$/.test(vm)) throw new SafeError("e2_target_not_isolated"); // exclusive test VM naming only
    set("host_consent", "PASS", null, started);
  } catch (error) { set("host_consent", "NOT_VERIFIED", safeCode(error), started); return finalize(); }

  started = Date.now();
  try {
    const output = await (overrides?.readOutput ?? readHostVmList)();
    const row = parseVmInventory(output).vms.find(item => item.vm_name === vm);
    if (!row) throw new SafeError("e2_target_absent");
    if (row.provider !== "claude") throw new SafeError("e2_target_not_claude");
    if (row.state !== "running") throw new SafeError("e2_target_not_running");
    set("target_running", "PASS", null, started);
  } catch (error) {
    const code = safeCode(error);
    set("target_running", code === "e2_target_absent" || code === "e2_target_not_running" ? "NOT_VERIFIED" : "FAIL", code, started);
    return finalize();
  }

  // Read-only capability checks (no prompt, no quota).
  let caps: Capabilities | null = null;
  try {
    started = Date.now();
    const version = await execOnce(spawn, vm, ["claude", "--version"], 20_000);
    const help = await execOnce(spawn, vm, ["claude", "--help"], 20_000);
    caps = probeCapabilities(version.stdout, help.stdout);
    report.claude_version = caps.version;
    set("version", caps.version && version.code === 0 ? "PASS" : "FAIL", caps.version ? null : "version_unparseable", started, { version: caps.version });
    started = Date.now();
    set("capabilities", caps.missing.length === 0 ? "PASS" : "FAIL", caps.missing.length ? "missing_flags" : null, started,
      { permission_prompt: caps.permissionPrompt, missing: caps.missing.join(",") || null, resume: caps.flags["--resume"] ?? false, partial_messages: caps.flags["--include-partial-messages"] ?? false });
  } catch (error) { set(checks.find(c => c.id === "version")!.status === "NOT_VERIFIED" ? "version" : "capabilities", "FAIL", safeCode(error), started); return finalize(); }

  try {
    started = Date.now();
    const auth = await execOnce(spawn, vm, ["claude", "auth", "status", "--json"], 20_000);
    let parsed: unknown = null;
    try { parsed = JSON.parse(auth.stdout); } catch { /* handled below */ }
    const record = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
    const loggedIn = record?.loggedIn === true;
    // Only a boolean and a closed enum survive: identity fields (e-mail, organisation, tokens) are dropped here.
    const method = typeof record?.authMethod === "string" && /^(claude\.ai|api_key|console|oauth_token)$/.test(record.authMethod) ? record.authMethod : "other";
    set("auth_state", record ? (loggedIn ? "PASS" : "FAIL") : "FAIL", record ? (loggedIn ? null : "not_logged_in") : "auth_status_unparseable", started, { logged_in: loggedIn, method });
  } catch (error) { set("auth_state", "FAIL", safeCode(error), started); }

  if (checks.some(check => check.status === "FAIL")) return finalize();
  if (!report.real_prompts) {
    for (const id of ["streaming_turn", "multi_turn_same_process", "interrupt", "approval_reject", "question_answer", "process_exit", "resume", "error_classification"] as const) {
      checks.find(c => c.id === id)!.reason = "prompts_not_authorized";
    }
    return finalize();
  }
  const permissionPrompt = caps!.permissionPrompt!;

  // ------------------------------------------------------------------ real turns (consumes quota: 6 short prompts)
  const sessionId = randomUUID();
  const open = (extra: { sessionId?: string; resume?: string }) => new ClaudeStreamProcess(spawn(claudeStreamArgv(vm, { permissionPrompt, ...extra }), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: minimalChildEnv() }));
  const processes: ClaudeStreamProcess[] = [];
  let unexpectedPermissionRequests = 0;
  /** Runs one turn. Unexpected permission/question requests are DENIED (never auto-approved) and counted. */
  const turn = async (proc: ClaudeStreamProcess, prompt: string, handlers: { onEvent?: (event: ClaudeEvent) => Promise<"stop" | void> } = {}) => {
    await proc.send(userMessage(prompt));
    const seen: ClaudeEvent[] = [];
    const deadline = Date.now() + turnTimeout;
    for (;;) {
      const event = await proc.next(Math.max(0, deadline - Date.now()));
      if (!event) return { events: seen, result: null as Extract<ClaudeEvent, { type: "result" }> | null, ended: proc.ended };
      seen.push(event);
      if (event.type === "result") return { events: seen, result: event, ended: false };
      const verdict = await handlers.onEvent?.(event);
      if (verdict === "stop") return { events: seen, result: null, ended: false };
      if ((event.type === "permission_request" || event.type === "question") && !handlers.onEvent) {
        unexpectedPermissionRequests += 1;
        await proc.send(toolDecision(event.requestId, "deny"));
      }
    }
  };
  const text = (events: ClaudeEvent[]) => events.map(event => event.type === "assistant" ? event.text : "").join("");
  let exit: ExitReport | null = null;
  try {
    const p1 = open({ sessionId }); processes.push(p1);

    started = Date.now();
    const first = await turn(p1, PROMPTS.remember);
    const init = first.events.find(event => event.type === "init");
    const deltas = first.events.filter(event => event.type === "delta").length;
    const firstDeltaBeforeResult = first.events.findIndex(event => event.type === "delta") >= 0;
    const okStream = init?.type === "init" && init.sessionId === sessionId && first.result?.ok === true && firstDeltaBeforeResult;
    set("streaming_turn", okStream ? "PASS" : "FAIL", okStream ? null : "stream_shape_unexpected", started,
      { init_seen: Boolean(init), session_id_matches: init?.type === "init" && init.sessionId === sessionId, delta_count: deltas, incremental: deltas >= 2, result_ok: first.result?.ok ?? false,
        permission_mode: init?.type === "init" ? init.permissionMode : null, unexpected_requests: unexpectedPermissionRequests });
    if (!okStream) throw new SafeError("e2_abort_after_stream_failure");

    started = Date.now();
    const second = await turn(p1, PROMPTS.recall);
    const remembered = text(second.events).includes(MEMO);
    set("multi_turn_same_process", second.result?.ok && remembered ? "PASS" : "FAIL", second.result?.ok && remembered ? null : "second_turn_failed", started, { result_ok: second.result?.ok ?? false, context_kept: remembered });

    started = Date.now();
    let acked: boolean | null = null; let sentInterrupt = false;
    const requestId = `e2-int-${randomUUID()}`;
    const third = await turn(p1, PROMPTS.long, { onEvent: async event => {
      if (event.type === "delta" && !sentInterrupt) { sentInterrupt = true; await p1.send(interruptRequest(requestId)); }
      if (event.type === "control_ack" && event.requestId === requestId) acked = event.ok;
    } });
    // The turn may end with its result before or after the ack; give the ack a moment, then verify the process is still usable.
    const tail = third.result ? { events: [] as ClaudeEvent[] } : await p1.collect(event => event.type === "result", turnTimeout).then(r => ({ events: r.events }));
    for (const event of tail.events) if (event.type === "control_ack" && event.requestId === requestId) acked = event.ok;
    const ended = third.result ?? tail.events.find((event): event is Extract<ClaudeEvent, { type: "result" }> => event.type === "result") ?? null;
    set("interrupt", sentInterrupt && ended && !p1.ended ? "PASS" : sentInterrupt ? "FAIL" : "INCONCLUSIVE", sentInterrupt ? (ended ? null : "turn_did_not_end") : "no_streaming_before_end", started,
      { interrupt_sent: sentInterrupt, ack: acked, turn_ended: Boolean(ended), result_ok: ended?.ok ?? null, result_subtype: ended?.subtype ?? null, process_alive: !p1.ended });

    started = Date.now();
    let asked: { tool: string } | null = null;
    const approval = await turn(p1, PROMPTS.approval, { onEvent: async event => {
      if (event.type === "permission_request") { asked = { tool: event.tool }; await p1.send(toolDecision(event.requestId, "deny")); }
      if (event.type === "question") await p1.send(toolDecision(event.requestId, "deny"));
    } });
    set("approval_reject", asked && approval.result ? "PASS" : approval.result ? "INCONCLUSIVE" : "FAIL", asked ? (approval.result ? null : "turn_did_not_end_after_deny") : "no_permission_request_seen", started,
      { request_seen: Boolean(asked), tool: (asked as { tool: string } | null)?.tool ?? null, decision: "deny", turn_ended: Boolean(approval.result) });

    started = Date.now();
    let questioned: { count: number } | null = null;
    const question = await turn(p1, PROMPTS.question, { onEvent: async event => {
      if (event.type === "question") {
        questioned = { count: event.questions.length };
        const first = event.questions[0]!;
        await p1.send(questionAnswer(event.requestId, event.raw, { [first.question]: first.options[0] ?? "A" }));
      }
      if (event.type === "permission_request") await p1.send(toolDecision(event.requestId, "deny"));
    } });
    set("question_answer", questioned && question.result ? "PASS" : question.result ? "INCONCLUSIVE" : "FAIL", questioned ? (question.result ? null : "turn_did_not_end_after_answer") : "no_question_seen", started,
      { question_seen: Boolean(questioned), questions: (questioned as { count: number } | null)?.count ?? 0, turn_ended: Boolean(question.result) });

    started = Date.now();
    exit = await p1.close(grace);
    set("process_exit", exit.exited && !exit.killed ? "PASS" : "FAIL", exit.exited ? (exit.killed ? "needed_sigkill" : null) : "process_still_alive", started, { exited: exit.exited, killed: exit.killed, code: exit.code });

    started = Date.now();
    const p2 = open({ resume: sessionId }); processes.push(p2);
    const resumed = await turn(p2, PROMPTS.recall);
    const resumedInit = resumed.events.find(event => event.type === "init");
    const same = resumedInit?.type === "init" && resumedInit.sessionId === sessionId;
    const kept = text(resumed.events).includes(MEMO);
    set("resume", resumed.result?.ok && same && kept ? "PASS" : "FAIL", resumed.result?.ok && same && kept ? null : "resume_failed", started, { same_session_id: Boolean(same), context_kept: kept, result_ok: resumed.result?.ok ?? false });
    await p2.close(grace);
  } catch (error) {
    const first = checks.find(check => check.status === "NOT_VERIFIED" && check.reason === "not_exercised" && check.id !== "error_classification");
    if (first) set(first.id, "FAIL", safeCode(error), started);
  } finally {
    for (const proc of processes) if (!proc.ended) await proc.close(grace).catch(() => {});
  }
  set("error_classification", "NOT_VERIFIED", "not_forceable_without_exhausting_quota", Date.now()); // covered by fake-protocol tests only
  return finalize();
}

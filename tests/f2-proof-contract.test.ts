import { afterEach, describe, expect, test } from "bun:test";
import { RuntimeStore } from "../src/runtime-store.ts";
import { ProcessLedger } from "../src/process-ledger.ts";
import { ExecutionService } from "../src/execution.ts";
import { ClaudeCodeAdapter } from "../src/claude-adapter.ts";
import { EventHub } from "../src/event-hub.ts";
import { blockersOf, CLAUDE_PROOF_PROMPT, countRuns, hasEnoughPartial, judgeBlockedSend, judgePartialPreserved, judgeReconcileAfterRelease, judgeReconcileWhileOwnerAlive, parseOrphans,
  parseReconcile, parseReliability, readRunTranscript, type ProofHttp } from "../src/f2-proof.ts";
import { PROOF_PROBE_PROMPT, PROOF_PROMPT } from "../src/f1-systemd-smoke.ts";
import type { Snapshot } from "../src/model.ts";
import { closeHarnesses, harness } from "./support/e4-harness.ts";
import { cleanups, closeOrphanWorld, crashWithOrphan, deadIdentity, quiet, serve, sleepSpawn, turnStatus, until } from "./support/codex-orphan.ts";
import { FakeSystemd, historyAgentItem, historyUserItem, orphanItem, reconcileBody, reliabilityBody, runBody, sessionBody } from "./support/fake-systemd.ts";

/**
 * CONTRACT: the parsers and verdicts the isolated smoke uses (src/f2-proof.ts) are run here against the REAL stack — real HTTP
 * server, real ExecutionService, real RuntimeStore, real process ledger reading the real /proc, real dashboard — so the proof's
 * view of the API is not just the stand-in's. The orphan is a real `sleep`; the provider CLI is scripted (Claude) or the fake
 * App Server (Codex); the Cockpit "crash" is the E4 emulation (a second store/ExecutionService on the same database file, the
 * first one left without any orderly close), since one process cannot SIGKILL itself. Then the stand-in used by the end-to-end
 * tests is held to the real server's keys: it may invent no field the real Cockpit does not have.
 */
afterEach(async () => { await closeHarnesses(); await closeOrphanWorld(); });

const SESSION_UUID = /^[0-9a-f-]{36}$/i;
const claudeArgv = (vm: string, session: string) => ["msb", "exec", "--stream", vm, "--", "claude", "-p", "--input-format", "stream-json", "--resume", session];
const claudeSnapshot = async (): Promise<Snapshot> => ({ source: "mock", host_verification: "not_verified", observed_at: new Date().toISOString(), projects: ["alpha"],
  vms: [{ vm_name: "claude-alpha", project: "alpha", provider: "claude", state: "running", orphaned: false }] });
type Api = Awaited<ReturnType<typeof serve>>;
const asProof = (api: Api): ProofHttp => ({
  get: async path => { const response = await api.get(path); return { status: response.status, body: await response.json().catch(() => ({})) }; },
  post: async (path, payload, headers) => { const response = await api.post(path, payload, headers); return { status: response.status, body: await response.json().catch(() => ({})) }; },
});
const quiet2 = { newExecChildren: 0, unreadableChildren: 0, before: { providerConnections: 0, runsDispatched: 0 }, after: { providerConnections: 0, runsDispatched: 0 }, orphanAlive: true };
const key = () => `f2contract-${crypto.randomUUID()}`;
const keys = (value: unknown) => Object.keys(value as Record<string, unknown>);
const subset = (small: unknown, big: unknown) => keys(small).filter(name => !keys(big).includes(name));

describe.skipIf(process.platform !== "linux")("F2 contract: the smoke's Claude parsers and verdicts against the real stack", () => {
  test("session, streamed partial, kill, restart with a surviving claude_session: every verdict the smoke relies on is the one the real Cockpit produces", async () => {
    // ---- Cockpit #1: a real session and a real run whose partial answer streams in and is persisted
    const h = await harness({ partialFlushMs: 40 });
    const api1 = await serve(h.store, h.execution, ["alpha"], claudeSnapshot);
    const http1 = asProof(api1);
    const created = await http1.post("api/sessions", { vm_name: "claude-alpha", mode: "new" });
    expect(created.status).toBe(201);
    const sessionId = (created.body as { session_id: string }).session_id;
    const sent = await http1.post(`api/sessions/${sessionId}/runs`, { prompt: CLAUDE_PROOF_PROMPT }, { "Idempotency-Key": key() });
    expect(sent.status).toBe(202);
    const runId = (sent.body as { run_id: string }).run_id;
    const turn = await h.nextTurn();
    await until(() => h.store.getRun(runId)!.status, status => status === "running");
    turn.messageStart("msg_1");
    for (const piece of ["1. O mar é azul e fundo. ", "2. As ondas chegam à praia. ", "3. A maré sobe devagar. ", "4. O sal fica na pele."]) turn.text(piece);
    const before = await until(() => readRunTranscript(http1, sessionId, runId), transcript => hasEnoughPartial(transcript));
    expect([...before!.agentItems.values()].map(item => ({ inProgress: item.inProgress, incomplete: item.incomplete }))).toEqual([{ inProgress: true, incomplete: false }]); // live: in progress, not incomplete
    expect(before!.userMessages).toBe(1);
    await Bun.sleep(150); // no flush pending: what was read is what is on disk when the Cockpit "dies"

    // ---- the surviving `msb exec … claude -p --resume <session>` child (a real process) under a dead owner, then Cockpit #2
    const providerSessionId = h.store.getSession(sessionId)!.providerSessionId;
    expect(providerSessionId).toMatch(SESSION_UUID);
    const orphan = new ProcessLedger(h.store, { self: await deadIdentity(), log: quiet }).track(sleepSpawn)(claudeArgv("claude-alpha", providerSessionId), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} }) as unknown as Bun.Subprocess;
    const store2 = new RuntimeStore(h.path);
    cleanups.push(() => store2.close());
    const ledger = new ProcessLedger(store2, { log: quiet });
    expect(ledger.recover()).toMatchObject({ orphans: 1 });
    const execution2 = new ExecutionService({ store: store2, adapters: [new ClaudeCodeAdapter({ spawn: () => { throw new Error("no process may be spawned after a restart"); } })],
      hub: new EventHub(), refresh: claudeSnapshot, log: quiet, processes: ledger });
    cleanups.push(() => execution2.close());
    const api2 = await serve(store2, execution2, ["alpha"], claudeSnapshot);
    const http2 = asProof(api2);

    // ---- run_unknown_after_crash
    const runAfter = await api2.get(`api/runs/${runId}`).then(response => response.json()) as Record<string, unknown>;
    expect(runAfter).toMatchObject({ status: "unknown", reason_code: "process_restarted", provider_bound: true });

    // ---- orphan_ledger: the dashboard's attention item, as the smoke parses it
    const dashboard = await api2.get("api/dashboard").then(response => response.json()) as { attention: Array<Record<string, unknown>> };
    const orphans = parseOrphans(dashboard)!;
    expect(orphans).toEqual([{ pid: orphan.pid, vm: "claude-alpha", kind: "claude_session", blocks: "session", sessionId }]);
    expect(blockersOf(orphans, "claude", "claude-alpha", sessionId, [orphan.pid])).toHaveLength(1);
    expect(blockersOf(orphans, "claude", "claude-alpha", "ses-other", [orphan.pid])).toEqual([]); // another session is not blocked
    expect(blockersOf(orphans, "codex", "claude-alpha", sessionId, [orphan.pid])).toEqual([]);

    // ---- partial_preserved: the history after the restart
    const afterTranscript = await readRunTranscript(http2, sessionId, runId);
    const partial = judgePartialPreserved(before!, afterTranscript);
    expect(partial).toMatchObject({ status: "PASS", evidence: { prefix_preserved: true, marked_incomplete: true, user_messages: 1 } });
    expect(JSON.stringify(partial)).not.toContain("mar é azul");

    // ---- orphan_blocks_send: refused with 409, and the session still has exactly one run
    const blocked = await http2.post(`api/sessions/${sessionId}/runs`, { prompt: PROOF_PROBE_PROMPT }, { "Idempotency-Key": key() });
    expect(blocked.status).toBe(409);
    const sessionBody2 = (await http2.get(`api/sessions/${sessionId}`)).body;
    expect(countRuns(sessionBody2)).toBe(1);
    expect(judgeBlockedSend(blocked, countRuns(sessionBody2))).toMatchObject({ status: "PASS", evidence: { runs_in_session: 1 } });

    // ---- reconcile_conservative: Claude cannot confirm after a restart, and nothing is spawned (the spawn above would throw)
    const countersBefore = parseReliability((await http2.get("api/dashboard")).body);
    const reconcileRaw = await api2.post(`api/runs/${runId}/reconcile`, {}).then(response => response.json()) as Record<string, unknown>;
    const countersAfter = parseReliability((await http2.get("api/dashboard")).body);
    expect(countersBefore).not.toBeNull(); // the real dashboard exposes what the verdict reads
    const view = parseReconcile({ status: 200, body: reconcileRaw });
    expect(view).toEqual({ http: 200, status: "unknown", result: "unconfirmed", reason: "provider_cannot_confirm", errorCode: null });
    expect(countersAfter).toEqual(countersBefore); // the real Cockpit opened no connection and dispatched nothing
    expect(judgeReconcileWhileOwnerAlive("claude", view, { ...quiet2, before: countersBefore, after: countersAfter })).toMatchObject({ status: "PASS", evidence: { provider_connections_before: 0, provider_connections_after: 0 } });

    // ---- orphan_released + reconcile_after_release: the process ends; the Cockpit's own view releases; Claude still cannot confirm
    orphan.kill("SIGKILL");
    await orphan.exited;
    expect(parseOrphans((await http2.get("api/dashboard")).body)).toEqual([]);
    expect(judgeReconcileAfterRelease("claude", parseReconcile(await http2.post(`api/runs/${runId}/reconcile`, {})), true)).toMatchObject({ status: "PASS" });

    // ---- the stand-in's shapes may use no field the real Cockpit lacks
    const world = new FakeSystemd(true, {}, "claude").world;
    const realHistory = await api2.get(`api/sessions/${sessionId}/history?limit=500`).then(response => response.json()) as { items: Array<Record<string, unknown>> };
    const realUser = realHistory.items.find(item => item.kind === "user_message")!;
    const realAgent = realHistory.items.find(item => item.kind === "agent_message")!;
    expect(subset(historyUserItem("x", "t"), realUser)).toEqual([]);
    expect(subset(historyAgentItem("t", true), realAgent)).toEqual([]);
    expect(dashboard.attention.map(item => item.kind).sort()).toEqual(["orphan_process", "unknown_run"]); // the dashboard shows the lost run AND its orphan
    expect(subset(orphanItem(world, 1), dashboard.attention.find(item => item.kind === "orphan_process")!)).toEqual([]);
    expect(subset(runBody(world), runAfter)).toEqual([]);
    expect(subset(reliabilityBody(world), (dashboard as unknown as { reliability: Record<string, unknown> }).reliability)).toEqual([]);
    const realSession = await api2.get(`api/sessions/${sessionId}`).then(response => response.json()) as { session: Record<string, unknown>; runs: Array<Record<string, unknown>> };
    expect(subset(sessionBody(world), realSession)).toEqual([]);
    expect(subset(sessionBody(world).session, realSession.session)).toEqual([]);
    world.runsInSession = 1;
    expect(subset(sessionBody(world).runs[0], realSession.runs[0]!)).toEqual([]);
    expect(subset(reconcileBody(world, "unknown", "unconfirmed", "provider_cannot_confirm"), reconcileRaw)).toEqual([]);
    expect(keys(reconcileBody(world, "unknown", "unconfirmed", "provider_cannot_confirm").reconciliation).sort()).toEqual(keys(reconcileRaw.reconciliation).sort());
  });
});

describe.skipIf(process.platform !== "linux")("F2 contract: the smoke's Codex verdicts against the real stack", () => {
  test("a surviving app-server: listed as blocking the VM, send refused, reconcile refused with orphan_owns_turn; after the release the provider's own answer is what the smoke observes", async () => {
    const w = await crashWithOrphan();
    const api = await serve(w.store, w.after.execution, ["alpha"]);
    const http = asProof(api);
    const sessionId = w.session.sessionId;

    const orphans = parseOrphans((await http.get("api/dashboard")).body)!;
    expect(orphans).toEqual([{ pid: w.orphan.pid, vm: "codex-alpha", kind: "codex_app_server", blocks: "vm", sessionId: null }]);
    expect(blockersOf(orphans, "codex", "codex-alpha", sessionId, [w.orphan.pid])).toHaveLength(1);

    const blocked = await http.post(`api/sessions/${sessionId}/runs`, { prompt: PROOF_PROBE_PROMPT }, { "Idempotency-Key": key() });
    expect(judgeBlockedSend(blocked, countRuns((await http.get(`api/sessions/${sessionId}`)).body))).toMatchObject({ status: "PASS" });

    const before = parseReliability((await http.get("api/dashboard")).body);
    const owned = parseReconcile(await http.post(`api/runs/${w.run.runId}/reconcile`, {}));
    const after = parseReliability((await http.get("api/dashboard")).body);
    expect(owned).toEqual({ http: 200, status: "unknown", result: "unconfirmed", reason: "orphan_owns_turn", errorCode: null });
    expect(after).toEqual(before); // the refusal opened no provider connection (the smoke reads exactly this)
    expect(judgeReconcileWhileOwnerAlive("codex", owned, { ...quiet2, before, after })).toMatchObject({ status: "PASS" });
    expect(w.after.transports).toEqual([]); // nothing opened beside the orphan

    // The orphan ends while the turn still reads as in progress on the VM: what the smoke must call the open L4 case.
    w.orphan.kill("SIGKILL");
    await w.orphan.exited;
    expect(parseOrphans((await http.get("api/dashboard")).body)).toEqual([]);
    const reattached = parseReconcile(await http.post(`api/runs/${w.run.runId}/reconcile`, {}));
    expect(reattached).toMatchObject({ status: "running", result: "confirmed", reason: "reconciled" });
    expect(judgeReconcileAfterRelease("codex", reattached, true)).toMatchObject({ status: "NOT_VERIFIED", reason: "reattached_running_after_owner_ended" });
    expect(w.world.turnStarts).toBe(w.turnsBefore);
  });

  test("a surviving app-server whose turn finished on the VM: after the release the provider's confirmed status is what the smoke observes (PASS)", async () => {
    const w = await crashWithOrphan();
    const api = await serve(w.store, w.after.execution, ["alpha"]);
    const http = asProof(api);
    [...w.world.threads.values()].flatMap(thread => thread.turns).find(turn => turn.id === w.run.providerRunId)!.status = "completed";
    expect(turnStatus(w.world, w.run)).toBe("completed");
    w.orphan.kill("SIGKILL");
    await w.orphan.exited;
    const view = parseReconcile(await http.post(`api/runs/${w.run.runId}/reconcile`, {}));
    expect(view).toMatchObject({ status: "completed", result: "confirmed", reason: "reconciled" });
    expect(judgeReconcileAfterRelease("codex", view, true)).toMatchObject({ status: "PASS", evidence: { run_status: "completed" } });
    expect(PROOF_PROMPT).not.toBe(CLAUDE_PROOF_PROMPT);
  });
});

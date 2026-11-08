import { afterEach, describe, expect, test } from "bun:test";
import { RuntimeStore } from "../src/runtime-store.ts";
import { agentItems, closeHarnesses, harness, startTurn, until } from "./support/e4-harness.ts";

/** E4 — deterministic recovery scenarios (see tests/support/e4-harness.ts). */
afterEach(closeHarnesses);

describe("E4: partial responses are durable while the stream pauses", () => {
  test("the tail streamed just before a pause is persisted without waiting for another delta", async () => {
    const h = await harness({ partialFlushMs: 100 });
    const { session, turn } = await startTurn(h);
    turn.messageStart("msg_1");
    turn.text("Primeira parte. "); // first chunk: written at once
    await until(() => agentItems(h.store, session.sessionId), items => items.length === 1);
    turn.text("Cauda antes da pausa."); // inside the interval: before E4 this stayed in memory until the next delta
    // No further frame: the agent is "thinking" or waiting on a tool. The trailing write must land on its own.
    const items = await until(() => agentItems(h.store, session.sessionId), list => list[0]?.text === "Primeira parte. Cauda antes da pausa.", 1000);
    expect(items[0]).toMatchObject({ status: "in_progress" });
    expect(items[0]!.incomplete).toBeUndefined(); // the run is still active: in progress, not incomplete
  });

  test("abrupt end of the Cockpit (no orderly close): the restarted store shows the full streamed text as incomplete, run unknown", async () => {
    const h = await harness({ partialFlushMs: 50 });
    const { session, run, turn } = await startTurn(h);
    turn.messageStart("msg_1");
    for (const word of ["um ", "dois ", "três ", "quatro"]) turn.text(word);
    await until(() => agentItems(h.store, session.sessionId), list => list[0]?.text === "um dois três quatro", 1000);
    // "kill -9": nothing is flushed or closed; a new process opens the same file (same PID here, so the ownership probe allows it).
    const restarted = new RuntimeStore(h.path);
    try {
      expect(restarted.getRun(run.runId)).toMatchObject({ status: "unknown", reasonCode: "process_restarted" });
      const [item] = agentItems(restarted, session.sessionId);
      expect(item).toMatchObject({ text: "um dois três quatro", incomplete: true });
      // The prompt is there once; nothing was resent.
      expect(restarted.transcriptPage(session.sessionId).items.filter(entry => entry.kind === "user_message")).toHaveLength(1);
      expect(h.processes.flatMap(process => process.controlFrames)).toEqual([]);
    } finally { restarted.close(); }
  });

  test("the trailing write never resurrects a partial after the final message or after the run ended", async () => {
    const h = await harness({ partialFlushMs: 60 });
    const { session, run, turn } = await startTurn(h);
    turn.messageStart("msg_1");
    turn.text("rascunho ");
    turn.text("mais");
    turn.assistantText("msg_1", "versão final");
    turn.result(true);
    await until(() => h.store.getRun(run.runId)!.status, status => status === "completed");
    await Bun.sleep(150); // past any pending trailing write
    const [item] = agentItems(h.store, session.sessionId);
    expect(item).toMatchObject({ text: "versão final", status: "completed" });
    expect(item!.incomplete).toBeUndefined();
  });
});

const permission = (turn: import("./support/scripted-claude.ts").ScriptedTurn, requestId: string, command = "ls") =>
  turn.emit({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command }, tool_use_id: `toolu_${requestId.replaceAll("-", "")}` } });
const pendingApproval = (h: Awaited<ReturnType<typeof harness>>, runId: string) =>
  until(() => h.store.pendingApprovals().filter(item => item.runId === runId), list => list.length === 1).then(list => list[0]!);
const decisions = (h: Awaited<ReturnType<typeof harness>>) => h.processes.flatMap(process => process.controlFrames).filter(frame => frame.type === "control_response");

describe("E4: why a run is unknown (connection, process, VM)", () => {
  test("process death while the VM is still running stays provider_session_lost", async () => {
    const h = await harness();
    const { run, turn } = await startTurn(h);
    turn.exit(1);
    await until(() => h.store.getRun(run.runId)!, value => value.status === "unknown");
    await until(() => h.logs, logs => logs.some(entry => entry.event === "run.loss_classified"));
    expect(h.store.getRun(run.runId)).toMatchObject({ status: "unknown", reasonCode: "provider_session_lost" });
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "run.loss_classified", outcome: "vm_running" }));
  });

  test("the VM found stopped right after the loss turns the reason into vm_stopped; the status stays unknown", async () => {
    const h = await harness();
    const { run, turn } = await startTurn(h);
    h.vm.state = "stopped";
    turn.exit(137);
    const refined = await until(() => h.store.getRun(run.runId)!, value => value.reasonCode === "vm_stopped");
    expect(refined.status).toBe("unknown");
    const journal = h.store.replay(0, 1000).filter(event => event.runId === run.runId).map(event => [event.type, event.payload.to, event.payload.reasonCode ?? null]);
    expect(journal.slice(-2)).toEqual([["run.status_changed", "unknown", "provider_session_lost"], ["run.status_changed", "unknown", "vm_stopped"]]);
    expect(h.execution.reliability()).toMatchObject({ provider_session_lost: 1, vm_stopped: 1 });
  });

  test("a VM that disappeared from discovery is also vm_stopped; a failed discovery changes nothing and is logged", async () => {
    const gone = await harness();
    const first = await startTurn(gone);
    gone.vm.present = false;
    first.turn.exit(1);
    await until(() => gone.store.getRun(first.run.runId)!, value => value.reasonCode === "vm_stopped");

    const blind = await harness();
    const second = await startTurn(blind);
    blind.vm.refreshFails = true;
    second.turn.exit(1);
    await until(() => blind.logs, logs => logs.some(entry => entry.event === "run.loss_classified"));
    expect(blind.store.getRun(second.run.runId)).toMatchObject({ status: "unknown", reasonCode: "provider_session_lost" });
    expect(blind.logs).toContainEqual(expect.objectContaining({ event: "run.loss_classified", outcome: "discovery_failed" }));
  });

  test("refineUnknownReason only sharpens listed reasons of unknown runs", async () => {
    const h = await harness();
    const { run, turn } = await startTurn(h);
    expect(h.store.refineUnknownReason(run.runId, ["provider_session_lost"], "vm_stopped", new Date().toISOString())).toBeNull(); // running
    turn.result(true);
    await until(() => h.store.getRun(run.runId)!.status, status => status === "completed");
    expect(h.store.refineUnknownReason(run.runId, ["provider_session_lost"], "vm_stopped", new Date().toISOString())).toBeNull();
    expect(() => h.store.refineUnknownReason(run.runId, [], "Bad Code", new Date().toISOString())).toThrow("invalid_reason_code");
  });
});

describe("E4: conservative reconciliation", () => {
  test("Claude after its process died: unconfirmed (provider_cannot_confirm) without contacting the VM", async () => {
    const h = await harness();
    const { run, turn } = await startTurn(h);
    turn.exit(1);
    await until(() => h.store.getRun(run.runId)!.status, status => status === "unknown");
    const session = h.store.getSession(run.sessionId)!;
    const spawnsBefore = h.processes.length;
    const result = await h.execution.reconcile(h.store.getRun(run.runId)!, session);
    expect(result.outcome).toEqual({ result: "unconfirmed", reasonCode: "provider_cannot_confirm" });
    expect(result.run.status).toBe("unknown");
    expect(h.processes.length).toBe(spawnsBefore);
  });

  test("after a Cockpit restart nothing is spawned to reconcile, nothing is resent, and the run stays unknown", async () => {
    const h = await harness();
    const { run } = await startTurn(h, "tarefa longa");
    // Abrupt restart: a new store recovers, a new ExecutionService/adapter starts with no process at all.
    const store = new RuntimeStore(h.path);
    const { scriptedClaude } = await import("./support/scripted-claude.ts");
    const { newFakeWorld } = await import("../src/fake-claude.ts");
    const { ClaudeCodeAdapter } = await import("../src/claude-adapter.ts");
    const { ExecutionService } = await import("../src/execution.ts");
    const { EventHub } = await import("../src/event-hub.ts");
    const world = newFakeWorld();
    const fresh = scriptedClaude(world, () => { throw new Error("no prompt may be sent after a restart"); });
    const execution = new ExecutionService({ store, adapters: [new ClaudeCodeAdapter({ spawn: fresh.spawn })], hub: new EventHub(), log: () => {},
      refresh: async () => ({ source: "mock", host_verification: "not_verified", observed_at: new Date().toISOString(), projects: ["alpha"],
        vms: [{ vm_name: "claude-alpha", project: "alpha", provider: "claude", state: "running", orphaned: false }] }) });
    try {
      const recovered = store.getRun(run.runId)!;
      expect(recovered).toMatchObject({ status: "unknown", reasonCode: "process_restarted" });
      const result = await execution.reconcile(recovered, store.getSession(run.sessionId)!);
      expect(result.outcome).toEqual({ result: "unconfirmed", reasonCode: "provider_cannot_confirm" });
      expect(world.spawned).toEqual([]); // not even the read-only probe
      expect(fresh.processes).toEqual([]);
    } finally { await execution.close(); store.close(); }
  });

  test("a run whose prompt may have been sent but never got a provider id cannot be looked up: provider_run_unbound", async () => {
    const h = await harness();
    const target = await h.execution.revalidate("claude-alpha", "alpha");
    const session = await h.execution.openSession(target, "new");
    const at = new Date().toISOString();
    const { run } = h.store.beginRun({ runId: "run-unbound", sessionId: session.sessionId, idempotencyKey: "key-unbound", requestDigest: "c".repeat(64), createdAt: at });
    h.store.transition(run.runId, 1, "dispatching", at);
    h.store.transition(run.runId, 2, "unknown", at, { reasonCode: "dispatch_unconfirmed" });
    const result = await h.execution.reconcile(h.store.getRun(run.runId)!, session);
    expect(result.outcome).toEqual({ result: "unconfirmed", reasonCode: "provider_run_unbound" });
    expect(h.store.getRun(run.runId)).toMatchObject({ status: "unknown", reasonCode: "dispatch_unconfirmed" });
  });
});

describe("E4: a human decision is never reused or applied to another execution", () => {
  test("an approval of an interrupted turn cannot reach the next turn's request in the same process", async () => {
    const h = await harness();
    const { session, run, turn } = await startTurn(h, "turno A");
    permission(turn, "req-a", "rm -rf build");
    const stale = await pendingApproval(h, run.runId);
    await h.execution.interrupt(h.store.getRun(run.runId)!, session);
    turn.result(false);
    await until(() => h.store.getRun(run.runId)!.status, status => status === "interrupted");
    expect(h.store.getApproval(stale.approvalId)).toMatchObject({ status: "expired", reasonCode: "run_ended" });

    const { run: next } = await h.execution.startRun(session, "turno B", `key-${crypto.randomUUID()}`);
    const turnB = await h.nextTurn();
    permission(turnB, "req-b", "rm -rf build");
    await pendingApproval(h, next.runId);
    await expect(h.execution.decide(h.store.getApproval(stale.approvalId)!, "approve", stale.version)).rejects.toThrow("approval_conflict");
    expect(decisions(h)).toEqual([]);
    expect(h.store.getRun(next.runId)!.status).toBe("awaiting_approval");
  });

  test("approvals do not survive the process that asked: after its death, or after a restart, a decision is refused and nothing is written", async () => {
    const h = await harness();
    const { run, turn } = await startTurn(h);
    permission(turn, "req-1");
    const approval = await pendingApproval(h, run.runId);
    turn.exit(1);
    await until(() => h.store.getApproval(approval.approvalId)!.status, status => status === "expired");
    await expect(h.execution.decide(h.store.getApproval(approval.approvalId)!, "approve", approval.version)).rejects.toThrow("approval_conflict");

    const { run: second, turn: other } = await startTurn(h);
    permission(other, "req-2");
    const before = await pendingApproval(h, second.runId);
    const restarted = new RuntimeStore(h.path); // abrupt restart: recovery expires every pending approval
    try {
      expect(restarted.getApproval(before.approvalId)).toMatchObject({ status: "expired", reasonCode: "process_restarted" });
      expect(() => restarted.resolveApproval(before.approvalId, before.version, "approved", new Date().toISOString())).toThrow("approval_conflict");
    } finally { restarted.close(); }
    expect(decisions(h)).toEqual([]);
  });

  test("a replayed decision (double click, retried request) is delivered exactly once", async () => {
    const h = await harness();
    const { run, turn } = await startTurn(h);
    permission(turn, "req-1");
    const approval = await pendingApproval(h, run.runId);
    const [first, second] = await Promise.all([
      h.execution.decide(approval, "approve", approval.version),
      h.execution.decide(approval, "approve", approval.version),
    ]);
    expect(first.status).toBe("approved");
    expect(second.status).toBe("approved");
    expect(decisions(h)).toHaveLength(1);
    await expect(h.execution.decide(h.store.getApproval(approval.approvalId)!, "reject", approval.version)).rejects.toThrow("approval_conflict");
    expect(decisions(h)).toHaveLength(1);
  });
});

describe("E4: logs and metrics never carry content or secrets", () => {
  test("a full turn with a secret in the prompt, an approval and a loss leaves only codes, ids and counts in the logs", async () => {
    const h = await harness();
    const secret = "sk-ant-api03-E4SEGREDOabcdefghijklmnop";
    const { run, turn } = await startTurn(h, `faça X com api_key=${secret} e PROMPT-CANARIO`);
    turn.messageStart("msg_1");
    turn.text("RESPOSTA-CANARIO ");
    permission(turn, "req-1", `curl -H 'Authorization: Bearer ${secret}'`);
    const approval = await pendingApproval(h, run.runId);
    await h.execution.decide(approval, "reject", approval.version);
    turn.exit(1);
    await until(() => h.logs, logs => logs.some(entry => entry.event === "run.loss_classified"));
    const text = JSON.stringify(h.logs) + JSON.stringify(h.execution.reliability());
    for (const forbidden of [secret, "PROMPT-CANARIO", "RESPOSTA-CANARIO", "curl", "Authorization"]) expect(text).not.toContain(forbidden);
    for (const entry of h.logs) for (const key of ["outcome", "error_code", "reason_code"] as const) {
      const value = entry[key];
      if (value !== undefined) expect(value).toMatch(/^[A-Za-z0-9_.;=-]{1,96}$/);
    }
    expect(h.execution.reliability()).toMatchObject({ runs_dispatched: 1, provider_session_lost: 1, active_runs: 0 });
  });
});

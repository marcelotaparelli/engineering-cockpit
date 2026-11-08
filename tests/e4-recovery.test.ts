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

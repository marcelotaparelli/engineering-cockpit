import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { ProcessLedger, procProbe } from "../src/process-ledger.ts";
import { children, closeOrphanWorld, cockpit, crashWithOrphan, deadIdentity, quiet, serve, until } from "./support/codex-orphan.ts";
import type { FakeCodexWorld } from "../src/fake-codex.ts";

/**
 * F2-M1, adversarial closing. The invariants the operator relies on, each attacked from the side that would break it:
 *  - nothing is ever signalled by recovery/reconcile (the orphan and an unrelated process stay alive, untouched);
 *  - a PID reused by a stranger is never mistaken for the orphan;
 *  - nothing is resent: replay returns the original run, a new key is refused, no run row and no turn is created;
 *  - the answer is the same however many times and however concurrently it is asked, and across further restarts;
 *  - the refusal does not leak to an operator without a grant, and carries no PID, VM name or provider text.
 * The orphan is a real `sleep` in the real /proc; the provider is the deterministic fake App Server (see support/codex-orphan.ts).
 */
afterEach(async () => { await closeOrphanWorld(); });

const alive = (pid: number) => procProbe.startTicks(pid) !== null;

describe.skipIf(process.platform !== "linux")("F2-M1 adversarial: recovery never signals, never resends, never guesses", () => {
  test("no process is signalled by recovery, reconcile, a blocked send, an interrupt or an orderly close: the orphan and a bystander stay alive and unchanged", async () => {
    const bystander = Bun.spawn(["sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    children.push(bystander);
    const w = await crashWithOrphan();
    const orphanTicks = procProbe.startTicks(w.orphan.pid);
    const bystanderTicks = procProbe.startTicks(bystander.pid);
    expect(orphanTicks).not.toBeNull();
    const kill = spyOn(process, "kill");
    try {
      for (let i = 0; i < 3; i++) {
        expect((await w.after.execution.reconcile(w.store.getRun(w.run.runId)!, w.session)).outcome).toEqual({ result: "unconfirmed", reasonCode: "orphan_owns_turn" });
      }
      await expect(w.after.execution.startRun(w.session, "outra tarefa", `key-${crypto.randomUUID()}`)).rejects.toThrow("orphan_process_alive");
      await expect(w.after.execution.interrupt(w.store.getRun(w.run.runId)!, w.session)).rejects.toThrow("run_not_interruptible");
      w.ledger.recover();
      expect(w.ledger.orphans()).toHaveLength(1);
      await w.after.execution.close(); // the restarted Cockpit shuts down in order, while the orphan lives
      expect(kill.mock.calls).toEqual([]);
    } finally { kill.mockRestore(); }
    expect(procProbe.startTicks(w.orphan.pid)).toBe(orphanTicks);
    expect(procProbe.startTicks(bystander.pid)).toBe(bystanderTicks);
    expect(w.world.turnStarts).toBe(w.turnsBefore);
  });

  test("static guard: only reviewed files signal a process by PID, and the recovery, execution, HTTP, dashboard and store code contain no signal call at all", () => {
    const dir = new URL("../src/", import.meta.url);
    const source = (name: string) => readFileSync(new URL(name, dir), "utf8");
    const files = readdirSync(dir).filter(name => name.endsWith(".ts"));
    // Each of these is a reviewed exception: the E0 homologation runner (its own Cockpit) and the F1 smoke (`terminate`, which
    // re-checks membership in its OWN unit's cgroup before every signal). A new entry here needs a security review.
    expect(files.filter(name => /\bprocess\.kill\s*\(/.test(source(name))).sort()).toEqual(["e0-recovery.ts", "f1-systemd-smoke.ts"]);
    for (const name of ["execution.ts", "process-ledger.ts", "dashboard.ts", "server.ts", "runtime-store.ts", "local-security.ts"]) {
      expect(/\.kill\s*\(/.test(source(name)), `${name} must not signal anything`).toBe(false);
    }
    // Nor may they run a `kill`/`pkill`/`killall` command (spawn(["kill", …]) is a signal too), anywhere but the two reviewed files (the smoke's `systemctl kill`, the E0 runner's step labels).
    for (const name of files) if (name !== "f1-systemd-smoke.ts" && name !== "e0-recovery.ts") expect(/["'`](?:p?kill|killall)["'`]/.test(source(name)), `${name} must not run a kill command`).toBe(false);
  });

  test("a ledger row whose PID was reused by a stranger is forgotten, never treated as the orphan, never signalled, and does not block the reconcile", async () => {
    const worlds = new Map<string, FakeCodexWorld>();
    const { tempStore, turnInFlight } = await import("./support/codex-orphan.ts");
    const db = await tempStore();
    const first = db.open();
    const before = cockpit(first, worlds);
    const { run } = await turnInFlight(before.execution, first);
    const stranger = Bun.spawn(["sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    children.push(stranger);
    const dead = await deadIdentity();
    // The ledger remembers a Codex app-server under this PID, but with another kernel start time: the PID now belongs to a stranger.
    first.recordChild({ pid: stranger.pid, startTicks: "1", ownerPid: dead.pid, ownerStartTicks: dead.startTicks, kind: "codex_app_server", vmName: "codex-alpha",
      providerSessionId: null, createdAt: new Date().toISOString() });
    before.transports[0]!.transport.crash();
    await until(() => first.getRun(run.runId)!.status, status => status === "unknown");
    const strangerTicks = procProbe.startTicks(stranger.pid);

    const store = db.open();
    const ledger = new ProcessLedger(store, { log: quiet });
    expect(ledger.recover()).toEqual({ orphans: 0, forgotten: 1, foreign: 0 });
    expect(ledger.orphans()).toEqual([]);
    const after = cockpit(store, worlds, ledger);
    [...worlds.get("codex-alpha")!.threads.values()].flatMap(thread => thread.turns).find(turn => turn.id === run.providerRunId)!.status = "completed";
    const result = await after.execution.reconcile(store.getRun(run.runId)!, store.getSession(run.sessionId)!);
    expect(result.outcome).toEqual({ result: "confirmed", reasonCode: "reconciled" }); // asked the provider: the stranger holds nothing
    expect(procProbe.startTicks(stranger.pid)).toBe(strangerTicks); // and was left alone
  });

  test("nothing is resent while the orphan lives: the same key replays the original run, a changed prompt on that key conflicts, a new key is refused; no run row, no turn", async () => {
    const w = await crashWithOrphan();
    const runsBefore = w.store.listRuns(w.session.sessionId, 50).length;
    expect(runsBefore).toBe(1);
    const replay = await w.after.execution.startRun(w.session, w.prompt, w.key);
    expect(replay.created).toBe(false);
    expect(replay.run.runId).toBe(w.run.runId);
    await expect(w.after.execution.startRun(w.session, `${w.prompt} (alterado)`, w.key)).rejects.toThrow("idempotency_key_conflict");
    await expect(w.after.execution.startRun(w.session, w.prompt, `key-${crypto.randomUUID()}`)).rejects.toThrow("orphan_process_alive");
    await expect(w.after.execution.startRun(w.session, "Responda apenas: ok.", `key-${crypto.randomUUID()}`)).rejects.toThrow("orphan_process_alive");
    expect(w.store.listRuns(w.session.sessionId, 50)).toHaveLength(runsBefore);
    expect(w.world.turnStarts).toBe(w.turnsBefore);
    expect(w.after.transports).toEqual([]);
    expect(w.after.execution.reliability()).toMatchObject({ dispatch_blocked_orphan: 2, runs_dispatched: 0 });
  });

  test("eight concurrent reconciles while the orphan lives all get the same refusal and open no connection", async () => {
    const w = await crashWithOrphan();
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => w.after.execution.reconcile(w.store.getRun(w.run.runId)!, w.session)));
    expect(new Set(outcomes.map(item => `${item.outcome.result}/${item.outcome.reasonCode}/${item.run.status}`))).toEqual(new Set(["unconfirmed/orphan_owns_turn/unknown"]));
    expect(w.after.transports).toEqual([]);
    expect(w.world.turnStarts).toBe(w.turnsBefore);
    expect(w.after.execution.reliability()).toMatchObject({ reconcile_unconfirmed: 8, reconcile_confirmed: 0, active_runs: 0, provider_connections: 0 });
  });

  test("the answer survives further restarts: a third Cockpit on the same database still finds the orphan and still refuses", async () => {
    const w = await crashWithOrphan();
    const store3 = w.db.open();
    const ledger3 = new ProcessLedger(store3, { log: quiet });
    expect(ledger3.recover()).toMatchObject({ orphans: 1 });
    const third = cockpit(store3, w.worlds, ledger3);
    const result = await third.execution.reconcile(store3.getRun(w.run.runId)!, store3.getSession(w.run.sessionId)!);
    expect(result.outcome).toEqual({ result: "unconfirmed", reasonCode: "orphan_owns_turn" });
    expect(result.run.status).toBe("unknown");
    expect(third.transports).toEqual([]);
    expect(alive(w.orphan.pid)).toBe(true);
  });

  test("an operator without a grant for the project gets 404 and learns nothing about the orphan; one with the grant gets the closed-vocabulary refusal, with no PID, VM name or provider text", async () => {
    const w = await crashWithOrphan();
    const outsider = await serve(w.store, w.after.execution, ["beta"]);
    const denied = await outsider.post(`api/runs/${w.run.runId}/reconcile`);
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toMatch(/orphan|codex-alpha|pid/i);

    const owner = await serve(w.store, w.after.execution, ["alpha"]);
    const granted = await owner.post(`api/runs/${w.run.runId}/reconcile`);
    expect(granted.status).toBe(200);
    const text = await granted.text();
    expect(JSON.parse(text)).toMatchObject({ status: "unknown", reconciliation: { result: "unconfirmed", reason_code: "orphan_owns_turn" } });
    expect(text).not.toMatch(/codex-alpha|"pid"|elicit|sleep/);
    expect(text).not.toContain(String(w.orphan.pid) + ",");
    const allowed = new Set(["event", "run_id", "outcome", "error_code", "reason_code", "provider", "duration_ms"]);
    for (const entry of w.after.logs) expect(Object.keys(entry).filter(key => !allowed.has(key))).toEqual([]);
    expect(JSON.stringify(w.after.logs)).not.toMatch(/codex-alpha|elicit/);
  });

  test("RESIDUAL, still open (master plan L4 / question P3): once the orphan has ended while the VM still reports the turn in progress, concurrent reconciles reattach it exactly once", async () => {
    // This pins the documented E0 behaviour that F2-M1 deliberately does NOT change (docs/f2-prova-provider-real.md §6): after the
    // orphan is gone, the provider is asked, and a turn that still reads as in progress is reattached (running, nothing resent).
    // If P3 is decided differently, this test is the one to change, on purpose.
    const w = await crashWithOrphan();
    w.orphan.kill("SIGKILL");
    await w.orphan.exited;
    const settled = await Promise.allSettled([
      w.after.execution.reconcile(w.store.getRun(w.run.runId)!, w.session),
      w.after.execution.reconcile(w.store.getRun(w.run.runId)!, w.session),
    ]);
    const fulfilled = settled.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof w.after.execution.reconcile>>> => item.status === "fulfilled");
    const rejected = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value.outcome).toEqual({ result: "confirmed", reasonCode: "reconciled" });
    expect(fulfilled[0]!.value.run.status).toBe("running");
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]!.reason)).toContain("project_busy");
    expect(w.after.execution.reliability()).toMatchObject({ active_runs: 1, reconcile_confirmed: 1 });
    expect(w.world.turnStarts).toBe(w.turnsBefore); // never a second turn
  });
});

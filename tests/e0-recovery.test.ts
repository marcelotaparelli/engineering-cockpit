import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRecoveryTest, TARGET_PROJECT, TARGET_VM, type ProcessControl, type RecoveryDeps, type ServerProcess } from "../src/e0-recovery.ts";
import { startServer } from "../src/server.ts";
import { LocalSecurity } from "../src/local-security.ts";
import { RuntimeStore } from "../src/runtime-store.ts";
import { EventHub } from "../src/event-hub.ts";
import { ExecutionService } from "../src/execution.ts";
import { CodexAppServerAdapter } from "../src/codex-adapter.ts";
import { FakeCodexTransport, FakeCodexWorld } from "../src/fake-codex.ts";
import type { Snapshot } from "../src/model.ts";

/**
 * Real Cockpit HTTP server + ExecutionService + RuntimeStore + fake App Server. Only the OS process layer is faked:
 * "kill" abandons the instance without any graceful close (like SIGKILL) and "spawn" boots a new one on the same SQLite file.
 */
const token = "ab".repeat(32);
const arch = { platform: "linux", osRelease: "ID=arch\n", knownGuest: false };
const inventory = (extra: unknown[] = []) => JSON.stringify([
  { created_at: "2026-10-25T00:00:00Z", image: "x", name: TARGET_VM, status: "Running" },
  { created_at: "2026-10-25T00:00:00Z", image: "x", name: "claude-engineering-cockpit", status: "Running" }, ...extra]);

class Harness {
  dir = mkdtempSync(join(tmpdir(), "d7-"));
  tokenFile = join(this.dir, "token");
  world = new FakeCodexWorld();
  runtime!: RuntimeStore; server!: Bun.Server<undefined>; execution!: ExecutionService;
  pid = 100; killed: number[] = []; spawns = 0; port = 0; turnStartsAtKill = 0;
  inventoryNow = () => inventory();
  allowed = TARGET_PROJECT; vmState: "running" | "stopped" = "running";
  constructor() { writeFileSync(this.tokenFile, token + "\n", { mode: 0o600 }); chmodSync(this.tokenFile, 0o600); }
  snapshot = (): Snapshot => ({ source: "mock", host_verification: "not_verified", observed_at: new Date().toISOString(), projects: [TARGET_PROJECT],
    vms: [{ vm_name: TARGET_VM, project: TARGET_PROJECT, provider: "codex", state: this.vmState, orphaned: false },
      { vm_name: "codex-other", project: "other", provider: "codex", state: "running", orphaned: false }] });
  boot(): void {
    this.runtime = new RuntimeStore(join(this.dir, "runtime.sqlite"));
    const hub = new EventHub();
    const adapter = new CodexAppServerAdapter(() => new FakeCodexTransport(this.world, { delayMs: 10 }));
    this.execution = new ExecutionService({ store: this.runtime, adapter, hub, refresh: async () => this.snapshot(), log: () => {} });
    this.server = startServer({ source: "mock", port: this.port, security: new LocalSecurity(token, this.allowed.split(",")), runtime: this.runtime, execution: this.execution, hub,
      discovery: { refresh: async () => this.snapshot() }, log: () => {}, heartbeatMs: 50 });
    this.port = this.server.port!;
    this.pid++;
  }
  info(): ServerProcess {
    return { pid: this.pid, argv: ["/usr/bin/bun", "--no-env-file", "src/index.ts"], cwd: "/repo",
      env: { COCKPIT_MODE: "host", COCKPIT_HOST_CONFIRMED: "yes", COCKPIT_ALLOWED_PROJECTS: this.allowed, COCKPIT_LOCAL_TOKEN: token, PORT: String(this.port), COCKPIT_DATA_DIR: this.dir, COCKPIT_PROJECTS_BASE: "/projects" } };
  }
  proc: ProcessControl = {
    listening: async () => this.server ? [this.pid] : [],
    inspect: async () => this.info(),
    kill: async pid => { this.killed.push(pid); this.turnStartsAtKill = this.world.turnStarts; this.server.stop(true); this.server = undefined as never; this.runtime.close(); },
    alive: async () => false,
    spawn: async () => { this.spawns++; this.boot(); },
  };
  deps(over: Partial<RecoveryDeps> = {}, envOver: Record<string, string | undefined> = {}): RecoveryDeps {
    return {
      env: { COCKPIT_MODE: "host", COCKPIT_HOST_CONFIRMED: "yes", COCKPIT_E0_RECOVERY_CONFIRMED: "yes", COCKPIT_PORT: String(this.port), COCKPIT_TOKEN_FILE: this.tokenFile, ...envOver },
      facts: arch, root: "/repo", synthetic: true, readVmList: async () => this.inventoryNow(),
      fetch, proc: this.proc,
      probeRuntime: () => { throw new Error("db_unreadable_in_test"); }, // exercises the API-only fallback
      readToken: path => { const { statSync, readFileSync } = require("node:fs"); const st = statSync(path); return { token: readFileSync(path, "utf8").trim(), mode: st.mode & 0o777, owned: true }; },
      sleep: ms => Bun.sleep(Math.min(ms, 20)), timeouts: { activeMs: 5000, unknownMs: 3000, restartMs: 3000, settleMs: 3000 }, ...over,
    };
  }
  cleanup(): void { try { this.server?.stop(true); } catch { /* */ } try { this.runtime.close(); } catch { /* */ } rmSync(this.dir, { recursive: true, force: true }); }
}
let h: Harness;
afterEach(() => h?.cleanup());
process.on("unhandledRejection", () => {}); // the abandoned instance's in-flight writes hit a closed DB, as a dead process would

describe("E0 D7 recovery test (fake process/provider)", () => {
  test("happy path: active → SIGKILL only the cockpit → restart → unknown(process_restarted) → reconcile, prompt sent once, no secrets", async () => {
    h = new Harness(); h.boot();
    const report = await runRecoveryTest(h.deps());
    expect(report.reason).toBeNull();
    expect(report.overall).toBe("PASS");
    expect(h.killed).toEqual([101]);
    expect(h.spawns).toBe(1);
    expect(h.world.turnStarts).toBe(1);               // exactly one turn ever reached the provider
    expect(h.turnStartsAtKill).toBe(1);
    expect(report.observed).toMatchObject({ status_after_restart: "unknown", reason_after_restart: "process_restarted", runs_in_session: 1 });
    expect(["completed", "interrupted", "running"]).toContain(report.observed.status_after_reconcile as string);
    expect(["completed", "interrupted", "running"]).toContain(report.observed.final_status as string); // fake interrupts are per-transport, so "running" is possible only here
    const text = JSON.stringify(report);
    for (const secret of [token, "sleep 300", "/repo", h.dir, "E0-D7 "]) expect(text).not.toContain(secret);
  });

  test("refuses without exact consent, with loose token file or without a listening cockpit — and kills nothing", async () => {
    h = new Harness(); h.boot();
    for (const [envOver, reason] of [
      [{ COCKPIT_E0_RECOVERY_CONFIRMED: "true" }, "recovery_confirmation_required"],
      [{ COCKPIT_E0_RECOVERY_CONFIRMED: undefined }, "recovery_confirmation_required"],
      [{ COCKPIT_TOKEN_FILE: "relative" }, "recovery_token_file_required"],
      [{ COCKPIT_PORT: "abc" }, "recovery_port_required"],
    ] as const) expect((await runRecoveryTest(h.deps({}, envOver))).reason).toBe(reason);
    chmodSync(h.tokenFile, 0o644);
    expect((await runRecoveryTest(h.deps())).reason).toBe("token_file_permissions");
    chmodSync(h.tokenFile, 0o600);
    expect((await runRecoveryTest(h.deps({ facts: { ...arch, osRelease: "ID=debian\n" } }))).reason).toBe("arch_host_required");
    expect((await runRecoveryTest(h.deps({ proc: { ...h.proc, listening: async () => [] } }))).reason).toBe("cockpit_not_listening");
    expect((await runRecoveryTest(h.deps({ proc: { ...h.proc, listening: async () => [1, 2] } }))).reason).toBe("cockpit_ambiguous");
    expect(h.killed).toEqual([]); expect(h.world.turnStarts).toBe(0);
  });

  test.each([
    ["different command", (i: ServerProcess) => ({ ...i, argv: ["/usr/bin/bun", "other.ts"] }), "cockpit_command_mismatch"],
    ["different cwd", (i: ServerProcess) => ({ ...i, cwd: "/elsewhere" }), "cockpit_cwd_mismatch"],
    ["not host mode", (i: ServerProcess) => ({ ...i, env: { ...i.env, COCKPIT_MODE: "mock" } }), "cockpit_not_host_mode"],
    ["more projects granted", (i: ServerProcess) => ({ ...i, env: { ...i.env, COCKPIT_ALLOWED_PROJECTS: "cockpit-e0-test,demo" } }), "cockpit_projects_not_isolated"],
    ["token differs from file", (i: ServerProcess) => ({ ...i, env: { ...i.env, COCKPIT_LOCAL_TOKEN: "z".repeat(64) } }), "cockpit_token_mismatch"],
  ])("refuses to touch a process that is not the identified e0 cockpit (%s)", async (_name, mutate, reason) => {
    h = new Harness(); h.boot();
    const report = await runRecoveryTest(h.deps({ proc: { ...h.proc, inspect: async () => mutate(h.info()) } }));
    expect(report.reason).toBe(reason);
    expect(h.killed).toEqual([]); expect(h.world.turnStarts).toBe(0);
  });

  test("refuses when other VMs are runnable, the target VM is not running, or a run is already active", async () => {
    h = new Harness(); h.boot();
    expect((await runRecoveryTest(h.deps({ readVmList: async () => JSON.stringify([{ created_at: "2026-10-25T00:00:00Z", image: "x", name: TARGET_VM, status: "Stopped" }]) }))).reason).toBe("target_vm_not_running");
    // an already active run in the isolated project
    const probe = h.deps({ probeRuntime: () => ({ activeRuns: 1, sessions: 1, runs: 1 }) });
    expect((await runRecoveryTest(probe)).reason).toBe("active_runs_present");
    h.server.stop(true); h.runtime.close(); h.allowed = "cockpit-e0-test,other"; h.boot();
    expect((await runRecoveryTest(h.deps({ proc: { ...h.proc, inspect: async () => ({ ...h.info(), env: { ...h.info().env, COCKPIT_ALLOWED_PROJECTS: TARGET_PROJECT } }) } }))).reason).toBe("other_vms_runnable");
    expect(h.killed).toEqual([]); expect(h.world.turnStarts).toBe(0);
  });

  test("a run that already ended is not killed over (never a fake PASS)", async () => {
    h = new Harness(); h.boot();
    h.world = new FakeCodexWorld();
    const original = h.proc.kill;
    const report = await runRecoveryTest(h.deps({ timeouts: { activeMs: 5000, unknownMs: 3000, restartMs: 3000, settleMs: 3000 },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await fetch(input, init);
        if (String(input).includes("/api/runs/") && !String(input).includes("/reconcile")) {
          const body = await response.clone().json() as Record<string, unknown>;
          return new Response(JSON.stringify({ ...body, status: "completed" }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return response;
      }) as typeof fetch }));
    expect(report).toMatchObject({ overall: "FAIL", reason: "run_ended_early_completed" });
    expect(h.killed).toEqual([]);
    void original;
  });

  test("other VM changing during the test fails integrity; restart that fails is attempted again and reported", async () => {
    h = new Harness(); h.boot();
    let calls = 0;
    const report = await runRecoveryTest(h.deps({ readVmList: async () => (++calls === 1 ? inventory() : inventory([{ created_at: "2026-10-25T00:00:00Z", image: "x", name: "codex-new", status: "Running" }])) }));
    expect(report).toMatchObject({ overall: "FAIL", reason: "other_vms_changed" });
    expect(h.spawns).toBe(1);

    h.cleanup(); h = new Harness(); h.boot();
    let spawns = 0;
    const failing = await runRecoveryTest(h.deps({ proc: { ...h.proc, spawn: async () => { spawns++; throw new Error("boom"); } } }));
    expect(failing.overall).toBe("FAIL");
    expect(spawns).toBe(2);                                   // normal attempt + emergency attempt
    expect(failing.observed.emergency_restart).toBe(false);
  });
});

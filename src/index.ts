import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "./config.ts";
import { readHostVmList } from "./adapter.ts";
import { Discovery, mockOutput } from "./discovery.ts";
import { SnapshotStore } from "./store.ts";
import { startServer } from "./server.ts";
import { safeCode } from "./model.ts";
import { assertNoSymlinks } from "./paths.ts";
import { assertArchHost } from "./host.ts";
import { assertRuntime } from "./runtime.ts";
import { LocalSecurity } from "./local-security.ts";
import { RuntimeStore } from "./runtime-store.ts";
import { EventHub } from "./event-hub.ts";
import { ExecutionService, loadDigestKey } from "./execution.ts";
import { CodexAppServerAdapter } from "./codex-adapter.ts";
import { hostSpawn, MsbStdioTransport } from "./msb-transport.ts";
import { ProcessLedger } from "./process-ledger.ts";
import { FakeCodexTransport, fakeWorld } from "./fake-codex.ts";
import { ClaudeCodeAdapter } from "./claude-adapter.ts";
import { fakeClaudeSpawn, newFakeWorld, type FakeClaudeWorld } from "./fake-claude.ts";

try {
  assertRuntime();
  const settings = config();
  if (settings.source === "host") assertArchHost();
  const security = new LocalSecurity(settings.localCredential, settings.allowedProjects);
  assertNoSymlinks(settings.databasePath);
  await mkdir(dirname(settings.databasePath), { recursive: true });
  const store = new SnapshotStore(settings.databasePath);
  // Refuses to start (`runtime_database_in_use`) while another process holds this data directory's runtime database.
  const runtime = new RuntimeStore(settings.runtimeDatabasePath);
  // E4: every real msb child is recorded; children a previous (crashed) Cockpit left running are reported and block their session/VM.
  const processes = new ProcessLedger(runtime);
  const spawn = processes.track(hostSpawn);
  const discovery = new Discovery({ ...settings, store, readOutput: settings.source === "mock" ? mockOutput : readHostVmList });
  const hub = new EventHub();
  // Mock mode never spawns anything: an in-process simulated App Server is clearly labelled as such in the UI.
  const adapter = new CodexAppServerAdapter(target => settings.source === "host"
    ? new MsbStdioTransport(target.vmName, spawn, { requestDeadlineMs: 30_000, maxStderrBytes: 8 * 1024 * 1024 })
    : new FakeCodexTransport(fakeWorld(target.vmName)));
  // Claude Code: `msb exec --stream` + `claude -p` stream-json on the host; an in-process simulated CLI in mock mode.
  const claudeWorlds = new Map<string, FakeClaudeWorld>();
  const claude = new ClaudeCodeAdapter(settings.source === "host" ? { spawn } : { spawn: (argv, options) => {
    const vm = argv[3] ?? "";
    let world = claudeWorlds.get(vm);
    if (!world) { world = newFakeWorld(); claudeWorlds.set(vm, world); }
    return fakeClaudeSpawn(world)(argv, options);
  } });
  const digestKey = loadDigestKey(join(dirname(settings.runtimeDatabasePath), "digest.key"));
  const execution = new ExecutionService({ store: runtime, adapters: [adapter, claude], hub, refresh: () => discovery.refresh(), digestKey, processes });
  const server = startServer({ discovery, source: settings.source, port: settings.port, security, runtime, execution, hub });
  console.log(JSON.stringify({ event: "listening", url: server.url.toString(), source: settings.source, host_verification: "not_verified", runtime_ownership: runtime.ownership }));
  // Synchronously after `listening` (the first stdout line is a contract) and before any request can be served.
  processes.recover();
  // Orderly shutdown runs once: a second signal (Ctrl+C reaches both the e3-homologation wrapper and this child) must not close
  // SQLite while the first pass is still recording partial answers and ending provider processes.
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
    if (stopping) { console.log(JSON.stringify({ event: "shutdown.repeated_signal", outcome: signal })); return; }
    stopping = true;
    void (async () => { server.stop(true); await execution.close().catch(() => {}); runtime.close(); store.close(); process.exit(0); })();
  });
} catch (error) {
  console.error(JSON.stringify({ event: "startup_failed", error_code: safeCode(error) }));
  process.exitCode = 1;
}

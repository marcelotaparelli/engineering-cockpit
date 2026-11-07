import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
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
import { ExecutionService } from "./execution.ts";
import { CodexAppServerAdapter } from "./codex-adapter.ts";
import { MsbStdioTransport } from "./msb-transport.ts";
import { FakeCodexTransport, fakeWorld } from "./fake-codex.ts";

try {
  assertRuntime();
  const settings = config();
  if (settings.source === "host") assertArchHost();
  const security = new LocalSecurity(settings.localCredential, settings.allowedProjects);
  assertNoSymlinks(settings.databasePath);
  await mkdir(dirname(settings.databasePath), { recursive: true });
  const store = new SnapshotStore(settings.databasePath);
  const runtime = new RuntimeStore(settings.runtimeDatabasePath);
  const discovery = new Discovery({ ...settings, store, readOutput: settings.source === "mock" ? mockOutput : readHostVmList });
  const hub = new EventHub();
  // Mock mode never spawns anything: an in-process simulated App Server is clearly labelled as such in the UI.
  const adapter = new CodexAppServerAdapter(target => settings.source === "host"
    ? new MsbStdioTransport(target.vmName, undefined, { requestDeadlineMs: 30_000 })
    : new FakeCodexTransport(fakeWorld(target.vmName)));
  const execution = new ExecutionService({ store: runtime, adapter, hub, refresh: () => discovery.refresh() });
  const server = startServer({ discovery, source: settings.source, port: settings.port, security, runtime, execution, hub });
  console.log(JSON.stringify({ event: "listening", url: server.url.toString(), source: settings.source, host_verification: "not_verified" }));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void (async () => { server.stop(true); await execution.close().catch(() => {}); runtime.close(); store.close(); process.exit(0); })(); });
} catch (error) {
  console.error(JSON.stringify({ event: "startup_failed", error_code: safeCode(error) }));
  process.exitCode = 1;
}

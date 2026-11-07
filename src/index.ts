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
  const server = startServer({ discovery, source: settings.source, port: settings.port, security, runtime });
  console.log(JSON.stringify({ event: "listening", url: server.url.toString(), source: settings.source, host_verification: "not_verified" }));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { server.stop(true); runtime.close(); store.close(); process.exit(0); });
} catch (error) {
  console.error(JSON.stringify({ event: "startup_failed", error_code: safeCode(error) }));
  process.exitCode = 1;
}

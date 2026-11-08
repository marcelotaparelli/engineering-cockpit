import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "../../src/config.ts";
import { Discovery, mockOutput } from "../../src/discovery.ts";
import { SnapshotStore } from "../../src/store.ts";
import { startServer } from "../../src/server.ts";
import { LocalSecurity } from "../../src/local-security.ts";
import { RuntimeStore } from "../../src/runtime-store.ts";
import { EventHub } from "../../src/event-hub.ts";
import { ExecutionService, loadDigestKey } from "../../src/execution.ts";
import { CodexAppServerAdapter } from "../../src/codex-adapter.ts";
import { ClaudeCodeAdapter } from "../../src/claude-adapter.ts";
import { FakeCodexTransport, fakeWorld } from "../../src/fake-codex.ts";
import { fakeClaudeSpawn, newFakeWorld, type FakeClaudeWorld } from "../../src/fake-claude.ts";

/**
 * The MOCK Cockpit composed in-process, exactly as `src/index.ts` composes it in mock mode, but with the session limits (and so
 * the clock-driven policy) under the caller's control. Used where a real browser must see a session expire in seconds instead of
 * 30 minutes. Production code has no environment variable for these limits and must not get one: the policy stays fixed there.
 */
export interface MockCockpit { origin: string; url: string; token: string; stop(): Promise<void> }

export async function startMockCockpit(options: { limits: { idleMs: number; maxMs: number }; token?: string }): Promise<MockCockpit> {
  const dir = await mkdtemp(join(tmpdir(), "cockpit-mock-inproc-"));
  const token = options.token ?? [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const settings = config({ COCKPIT_MODE: "mock", PORT: "0", COCKPIT_LOCAL_TOKEN: token, COCKPIT_ALLOWED_PROJECTS: "demo,lab", COCKPIT_DATA_DIR: dir });
  const security = new LocalSecurity(settings.localCredential, settings.allowedProjects, Date.now, options.limits);
  await mkdir(dirname(settings.databasePath), { recursive: true });
  const store = new SnapshotStore(settings.databasePath);
  const runtime = new RuntimeStore(settings.runtimeDatabasePath);
  const discovery = new Discovery({ ...settings, store, readOutput: mockOutput });
  const hub = new EventHub();
  const codex = new CodexAppServerAdapter(target => new FakeCodexTransport(fakeWorld(target.vmName)));
  const worlds = new Map<string, FakeClaudeWorld>();
  const claude = new ClaudeCodeAdapter({ reservedVms: settings.reservedVms, spawn: (argv, spawnOptions) => {
    const vm = argv[3] ?? "";
    let world = worlds.get(vm);
    if (!world) { world = newFakeWorld(); worlds.set(vm, world); }
    return fakeClaudeSpawn(world)(argv, spawnOptions);
  } });
  const execution = new ExecutionService({ store: runtime, adapters: [codex, claude], hub, refresh: () => discovery.refresh(), digestKey: loadDigestKey(join(dirname(settings.runtimeDatabasePath), "digest.key")),
    reservedVms: settings.reservedVms });
  const server = startServer({ discovery, source: "mock", port: 0, security, runtime, execution, hub, log: () => {} });
  const url = server.url.toString();
  return { url, origin: url.slice(0, -1), token, async stop() {
    server.stop(true); await execution.close().catch(() => {}); runtime.close(); store.close(); await rm(dir, { recursive: true, force: true });
  } };
}

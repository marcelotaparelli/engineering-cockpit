import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, readLocalCredentialFile, reservedVms } from "../src/config.ts";
import { buildDashboard } from "../src/dashboard.ts";
import { LocalSecurity } from "../src/local-security.ts";
import { RuntimeStore } from "../src/runtime-store.ts";
import { EventHub } from "../src/event-hub.ts";
import { ExecutionService } from "../src/execution.ts";
import { CodexAppServerAdapter } from "../src/codex-adapter.ts";
import { FakeCodexTransport, FakeCodexWorld } from "../src/fake-codex.ts";
import { ClaudeCodeAdapter } from "../src/claude-adapter.ts";
import { fakeClaudeSpawn, newFakeWorld } from "../src/fake-claude.ts";
import { claudeStreamArgv } from "../src/claude-protocol.ts";
import type { Snapshot } from "../src/model.ts";

const token = "0123456789abcdef".repeat(4);
const root = await mkdtemp(join(tmpdir(), "cockpit-f1-config-"));
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
async function tokenFile(name: string, content: string, mode = 0o600, dirMode = 0o700): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await chmod(dir, dirMode);
  const path = join(dir, "token");
  await writeFile(path, content, { mode });
  await chmod(path, mode);
  return path;
}

test("F1: the credential is read from a private 0600 file; the environment never carries it", async () => {
  const path = await tokenFile("ok", `${token}\n`);
  expect(readLocalCredentialFile(path)).toBe(token);
  const settings = config({ COCKPIT_LOCAL_TOKEN_FILE: path, COCKPIT_ALLOWED_PROJECTS: "demo" });
  expect(settings.localCredential).toBe(token);
  expect(() => new LocalSecurity(settings.localCredential, settings.allowedProjects)).not.toThrow();
});

test("F1: missing, insecure, linked, oversized or malformed credential files refuse startup with a code, never the value", async () => {
  const cases: Array<[string, string]> = [
    [await tokenFile("group-readable", token, 0o640), "local_credential_file_insecure"],
    [await tokenFile("world-readable", token, 0o644), "local_credential_file_insecure"],
    [await tokenFile("open-dir", token, 0o600, 0o777), "local_credential_file_insecure"],
    [await tokenFile("short", "abc\n"), "local_credential_file_invalid"],
    [await tokenFile("upper", token.toUpperCase()), "local_credential_file_invalid"],
    [await tokenFile("two-lines", `${token}\n\n`), "local_credential_file_invalid"],
    [await tokenFile("big", "a".repeat(300)), "local_credential_file_invalid"],
    [join(root, "absent", "token"), "local_credential_file_invalid"],
    ["relative/token", "local_credential_file_invalid"],
    [`${root}/ok/../ok/token`, "local_credential_file_invalid"],
  ];
  const linkDir = join(root, "link"); await mkdir(linkDir, { mode: 0o700 });
  await symlink(await tokenFile("target", token), join(linkDir, "token"));
  cases.push([join(linkDir, "token"), "local_credential_file_invalid"]);
  await mkdir(join(root, "dir-as-file", "token"), { recursive: true, mode: 0o700 }); await chmod(join(root, "dir-as-file"), 0o700);
  cases.push([join(root, "dir-as-file", "token"), "local_credential_file_invalid"]);
  for (const [path, code] of cases) {
    let message = "";
    try { readLocalCredentialFile(path); } catch (error) { message = (error as Error).message; }
    expect(`${path} → ${message}`).toBe(`${path} → ${code}`);
    expect(message).not.toContain(token);
  }
});

test("F1: token in the environment AND a token file is ambiguous and refused", async () => {
  const path = await tokenFile("ambiguous", token);
  expect(() => config({ COCKPIT_LOCAL_TOKEN_FILE: path, COCKPIT_LOCAL_TOKEN: token })).toThrow("local_credential_ambiguous");
  expect(() => config({ COCKPIT_LOCAL_TOKEN_FILE: path, COCKPIT_LOCAL_TOKEN: "" })).toThrow("local_credential_ambiguous");
  // The historical environment variable keeps working (terminal use).
  expect(config({ COCKPIT_LOCAL_TOKEN: token }).localCredential).toBe(token);
});

test("F1 (D8): COCKPIT_RESERVED_VMS only adds to the always-reserved development VM; invalid names refuse startup", () => {
  expect(reservedVms(undefined)).toEqual(["claude-engineering-cockpit"]);
  expect(config({}).reservedVms).toEqual(["claude-engineering-cockpit"]);
  expect(reservedVms("")).toEqual(["claude-engineering-cockpit"]); // an empty value can never unprotect the dev VM
  expect(reservedVms(",")).toEqual(["claude-engineering-cockpit"]);
  expect(reservedVms("codex-alpha")).toEqual(["claude-engineering-cockpit", "codex-alpha"]);
  expect(reservedVms("codex-alpha,claude-engineering-cockpit")).toEqual(["claude-engineering-cockpit", "codex-alpha"]);
  for (const bad of ["alpha", "codex-Alpha", "codex-a,codex-a", "codex-a, codex-b", "../x", "codex-"]) expect(() => reservedVms(bad)).toThrow("invalid_reserved_vms");
});

test("F1 (L6/D8): an observed VM the Cockpit will not operate is `unsupported` with its reason, not `offline`; stopped VMs stay offline", async () => {
  const dir = await mkdtemp(join(root, "dash-"));
  const store = new RuntimeStore(join(dir, "runtime.sqlite"));
  const world = newFakeWorld();
  const snapshot: Snapshot = { source: "mock", host_verification: "not_verified", observed_at: new Date().toISOString(), projects: ["alpha", "beta", "gamma", "engineering-cockpit"],
    vms: [
      { vm_name: "codex-alpha", project: "alpha", provider: "codex", state: "running", orphaned: false },
      { vm_name: "codex-beta", project: "beta", provider: "codex", state: "stopped", orphaned: false },
      { vm_name: "opencode-gamma", project: "gamma", provider: "opencode", state: "running", orphaned: false },
      { vm_name: "claude-engineering-cockpit", project: "engineering-cockpit", provider: "claude", state: "running", orphaned: false },
      { vm_name: "claude-alpha", project: "alpha", provider: "claude", state: "running", orphaned: false },
    ] };
  const reserved = ["codex-alpha", "claude-engineering-cockpit"];
  const execution = new ExecutionService({ store, hub: new EventHub(), refresh: async () => snapshot, log: () => {}, reservedVms: reserved,
    adapters: [new CodexAppServerAdapter(() => new FakeCodexTransport(new FakeCodexWorld())), new ClaudeCodeAdapter({ reservedVms: reserved, spawn: fakeClaudeSpawn(world) })] });
  try {
    const security = new LocalSecurity(token, ["alpha", "beta", "gamma", "engineering-cockpit"]);
    const login = security.login(token);
    const principal = security.authenticate(`cockpit_session=${login.cookie}`, login.proof);
    const view = buildDashboard({ store, execution, principal, security, snapshot, discoveryError: null, source: "mock" }) as { vms: Array<Record<string, unknown>> };
    const byName = Object.fromEntries(view.vms.map(vm => [vm.vm_name, vm]));
    expect(byName["codex-alpha"]).toMatchObject({ state: "unsupported", unsupported: "reserved", runnable: false, vm_state: "running" });
    expect(String(byName["codex-alpha"]!.next_step)).toContain("COCKPIT_RESERVED_VMS");
    expect(byName["claude-engineering-cockpit"]).toMatchObject({ state: "unsupported", unsupported: "reserved", runnable: false });
    expect(byName["opencode-gamma"]).toMatchObject({ state: "unsupported", unsupported: "provider", runnable: false });
    expect(String(byName["opencode-gamma"]!.next_step)).not.toContain("parada");
    expect(byName["codex-beta"]).toMatchObject({ state: "offline", unsupported: null, runnable: false });
    expect(byName["claude-alpha"]).toMatchObject({ state: "idle", unsupported: null, runnable: true });
    // A reserved VM is refused before anything is spawned, whatever its provider.
    await expect(execution.revalidate("codex-alpha", "alpha")).rejects.toThrow("target_unavailable");
    await expect(execution.revalidate("claude-engineering-cockpit")).rejects.toThrow("target_unavailable");
    expect(world.spawned).toHaveLength(0);
  } finally { await execution.close(); store.close(); }
});

test("F1 (D8): the configured list reaches the Claude argv guard; the development VM stays refused whatever the list", () => {
  expect(() => claudeStreamArgv("claude-engineering-cockpit", { permissionPrompt: "host" })).toThrow("e2_target_forbidden");
  expect(() => claudeStreamArgv("claude-alpha", { permissionPrompt: "host" }, ["claude-alpha"])).toThrow("e2_target_forbidden");
  expect(new ClaudeCodeAdapter({ reservedVms: [] }).acceptsTarget("claude-engineering-cockpit")).toBe(false);
  expect(new ClaudeCodeAdapter({ reservedVms: ["claude-alpha"] }).acceptsTarget("claude-alpha")).toBe(false);
  expect(new ClaudeCodeAdapter({ reservedVms: ["claude-alpha"] }).acceptsTarget("claude-engineering-cockpit")).toBe(false);
  expect(new ClaudeCodeAdapter().acceptsTarget("claude-beta")).toBe(true);
  // Any configuration path ends at the same union.
  expect(config({ COCKPIT_RESERVED_VMS: "" }).reservedVms).toContain("claude-engineering-cockpit");
});

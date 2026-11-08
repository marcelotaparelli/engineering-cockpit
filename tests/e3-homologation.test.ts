import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareE3Homologation, type E3PrepareOverrides } from "../src/e3-homologation.ts";
import { fakeClaudeSpawn, newFakeWorld, type FakeClaudeWorld } from "../src/fake-claude.ts";

/** E3 homologation preparation: read-only preflight + isolated launch plan. Fake CLI, temp dirs; nothing real is spawned. */
const VM = "claude-cockpit-e2-test";
const arch = { platform: "linux", osRelease: "ID=arch\n", knownGuest: false };
const listing = (state = "Running") => JSON.stringify([{ name: VM, status: state, image: "x", created_at: "2026-10-25T13:54:12.860454803+00:00" }]);
function setup(env: Record<string, string | undefined> = {}, extra: Partial<E3PrepareOverrides> = {}, world: FakeClaudeWorld = newFakeWorld()) {
  const base = mkdtempSync(join(tmpdir(), "e3-projects-"));
  mkdirSync(join(base, "cockpit-e2-test"));
  const repoRoot = mkdtempSync(join(tmpdir(), "e3-repo-"));
  const overrides: E3PrepareOverrides = {
    facts: arch, readOutput: async () => listing(), spawn: fakeClaudeSpawn(world), portInUse: async () => false, repoRoot,
    env: { COCKPIT_MODE: "host", COCKPIT_HOST_CONFIRMED: "yes", COCKPIT_E3_CONFIRMED: "yes", COCKPIT_E3_VM: VM, COCKPIT_PROJECTS_BASE: base,
      PATH: "/usr/bin", HOME: "/home/op", COCKPIT_LOCAL_TOKEN: "e0".repeat(32), PORT: "8787", ...env },
    ...extra,
  };
  return { overrides, world, base, repoRoot };
}
const check = (report: Awaited<ReturnType<typeof prepareE3Homologation>>["report"], id: string) => report.checks.find(item => item.id === id)!;

describe("E3 homologation preparation (isolated Cockpit, explicit authorization)", () => {
  test("ready: ACL is exactly the test project, own port/data/token; running instance's token, port and ACL are not reused", async () => {
    const { overrides, world, repoRoot } = setup();
    const { report, launch } = await prepareE3Homologation(overrides);
    expect(report.checks.filter(item => item.status !== "PASS")).toEqual([]);
    expect(report).toMatchObject({ ready: true, vm: VM, project: "cockpit-e2-test", port: 8788, data_dir: "data/e3-homologation" });
    expect(check(report, "claude_cli").evidence).toMatchObject({ version: "2.1.319", logged_in: true });
    expect(launch!.env).toMatchObject({ COCKPIT_MODE: "host", COCKPIT_ALLOWED_PROJECTS: "cockpit-e2-test", PORT: "8788",
      COCKPIT_DATA_DIR: join(repoRoot, "data", "e3-homologation"), PATH: "/usr/bin", HOME: "/home/op" });
    expect(launch!.env.COCKPIT_LOCAL_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect(launch!.env.COCKPIT_LOCAL_TOKEN).not.toBe("e0".repeat(32));
    expect(launch!.url).toBe("http://127.0.0.1:8788");
    // Preflight never sends a prompt nor opens a session: only version/help/auth.
    expect(world.spawned.map(item => item.argv.slice(5).join(" "))).toEqual(["claude --version", "claude --help", "claude auth status --json"]);
    const json = JSON.stringify(report);
    expect(json).not.toContain(launch!.token);
    expect(json).not.toContain("private@example.invalid");
    expect(json).not.toContain("ORG-SECRET");
  });

  test("a different ACL in the caller's environment is refused, never silently replaced", async () => {
    const { overrides, world } = setup({ COCKPIT_ALLOWED_PROJECTS: "cockpit-e0-test" });
    const { report, launch } = await prepareE3Homologation(overrides);
    expect(launch).toBeNull();
    expect(check(report, "acl")).toMatchObject({ status: "FAIL", reason: "e3_acl_mismatch" });
    expect(world.spawned).toHaveLength(0);
    const explicit = await prepareE3Homologation(setup({ COCKPIT_ALLOWED_PROJECTS: "cockpit-e2-test" }).overrides);
    expect(explicit.report.ready).toBe(true);
    expect(check(explicit.report, "acl").evidence).toMatchObject({ allowed_projects: "cockpit-e2-test", from_environment: true });
  });

  test.each([
    [{ COCKPIT_E3_CONFIRMED: undefined }, "e3_confirmation_required"],
    [{ COCKPIT_HOST_CONFIRMED: undefined }, "host_confirmation_required"],
    [{ COCKPIT_E3_VM: "claude-engineering-cockpit" }, "e2_target_forbidden"],
    [{ COCKPIT_E3_VM: "codex-cockpit-e2-test" }, "e2_target_not_claude"],
    [{ COCKPIT_E3_VM: "claude-cockpit-e0-test" }, "e3_target_not_isolated"],
    [{ COCKPIT_E3_PORT: "8787" }, "e3_port_reserved"],
    [{ COCKPIT_E3_PORT: "80" }, "e3_port_invalid"],
    [{ COCKPIT_PROJECTS_BASE: "relative" }, "host_projects_base_required"],
  ])("gate %p refuses before touching anything (%s)", async (env, reason) => {
    const { overrides, world } = setup(env as Record<string, string | undefined>);
    const { report, launch } = await prepareE3Homologation(overrides);
    expect(launch).toBeNull();
    expect(check(report, "host_consent")).toMatchObject({ status: "NOT_VERIFIED", reason });
    expect(world.spawned).toHaveLength(0);
  });

  test("non-Arch host is refused", async () => {
    const { overrides } = setup({}, { facts: { platform: "linux", osRelease: "ID=debian\n", knownGuest: false } });
    expect(check((await prepareE3Homologation(overrides)).report, "host_consent").reason).toBe("arch_host_required");
  });

  test("missing project directory, stopped VM, logged-out CLI and busy port each stop the preparation", async () => {
    const missing = setup();
    const noDir = { ...missing.overrides, env: { ...missing.overrides.env, COCKPIT_PROJECTS_BASE: mkdtempSync(join(tmpdir(), "e3-empty-")) } };
    expect(check((await prepareE3Homologation(noDir)).report, "project_dir")).toMatchObject({ status: "FAIL", reason: "e3_project_dir_missing" });
    const stopped = setup({}, { readOutput: async () => listing("Stopped") });
    expect(check((await prepareE3Homologation(stopped.overrides)).report, "target_running")).toMatchObject({ status: "NOT_VERIFIED", reason: "e3_target_not_running" });
    expect(stopped.world.spawned).toHaveLength(0);
    const world = newFakeWorld(); world.authLoggedIn = false;
    const loggedOut = setup({}, {}, world);
    const out = await prepareE3Homologation(loggedOut.overrides);
    expect(check(out.report, "claude_cli")).toMatchObject({ status: "FAIL", reason: "provider_auth_required" });
    expect(world.spawned.every(item => !item.argv.includes("stream-json"))).toBe(true);
    const busy = setup({}, { portInUse: async () => true });
    const result = await prepareE3Homologation(busy.overrides);
    expect(check(result.report, "port_free")).toMatchObject({ status: "FAIL", reason: "e3_port_in_use" });
    expect(result.launch).toBeNull();
  });

  test("a symlinked state directory and an invalid explicit token are refused", async () => {
    const linked = setup();
    mkdirSync(join(linked.repoRoot, "elsewhere"));
    symlinkSync(join(linked.repoRoot, "elsewhere"), join(linked.repoRoot, "data"));
    expect(check((await prepareE3Homologation(linked.overrides)).report, "data_dir").status).toBe("FAIL");
    const bad = setup({ COCKPIT_E3_LOCAL_TOKEN: "short" });
    expect((await prepareE3Homologation(bad.overrides)).launch).toBeNull();
    const good = setup({ COCKPIT_E3_LOCAL_TOKEN: "ab".repeat(32) });
    expect((await prepareE3Homologation(good.overrides)).launch).toMatchObject({ token: "ab".repeat(32), tokenGenerated: false });
  });
});

import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, link, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrantStore, MAX_UI_GRANTS } from "../src/grant-store.ts";
import { DEFAULT_RESERVED_PROJECTS, ProjectGrants, reservedProjects } from "../src/project-grants.ts";
import { LocalSecurity } from "../src/local-security.ts";
import { config } from "../src/config.ts";
import { validateSettings } from "../src/service.ts";
import { buildCatalog } from "../src/catalog.ts";
import type { Snapshot } from "../src/model.ts";

const work = await mkdtemp(join(tmpdir(), "cockpit-grants-"));
afterAll(async () => { await rm(work, { recursive: true, force: true }); });
let files = 0;
const fresh = () => join(work, `grants-${++files}.sqlite`);
const audit = (n = 1) => ({ actor: "local_operator:0123456789abcdef", requestId: `req-${n}`, at: new Date(Date.UTC(2026, 10, 9, 12, 0, n)).toISOString() });
const credential = "c".repeat(64);

test("store: private file, exact schema, persistent grants and an audit trail that cannot be rewritten", async () => {
  const path = fresh();
  const store = new GrantStore(path);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(store.grant("alpha", audit(1))).toBe(true);
  expect(store.grant("alpha", audit(2))).toBe(false); // idempotent: no second audit row
  expect(store.grant("beta", audit(3))).toBe(true);
  expect(store.revoke("beta", audit(4))).toBe(true);
  expect(store.revoke("beta", audit(5))).toBe(false);
  store.close();
  const reopened = new GrantStore(path);
  expect(reopened.list().map(row => row.project)).toEqual(["alpha"]);
  expect(reopened.audit().map(row => [row.action, row.project, row.requestId])).toEqual([["revoke", "beta", "req-4"], ["grant", "beta", "req-3"], ["grant", "alpha", "req-1"]]);
  reopened.close();
  const raw = new Database(path);
  expect(() => raw.exec("UPDATE grant_audit SET project='gamma'")).toThrow("grant_audit_append_only");
  expect(() => raw.exec("DELETE FROM grant_audit")).toThrow("grant_audit_append_only");
  raw.close();
});

test("store: refuses links, shared or foreign files, tampered rows and invalid input (fail closed)", async () => {
  const target = fresh();
  new GrantStore(target).close();
  const link = join(work, "link.sqlite");
  await symlink(target, link);
  expect(() => new GrantStore(link)).toThrow("symlink_path_denied");
  const dir = join(work, "linked-dir");
  await symlink(work, dir);
  expect(() => new GrantStore(join(dir, "x.sqlite"))).toThrow("symlink_path_denied");
  expect(() => new GrantStore("relative.sqlite")).toThrow("grant_store_denied");
  const shared = fresh();
  new GrantStore(shared).close();
  await chmod(shared, 0o644);
  expect(() => new GrantStore(shared)).toThrow("grant_store_denied");
  const foreign = fresh();
  await writeFile(foreign, "", { mode: 0o600 });
  const db = new Database(foreign);
  db.exec("CREATE TABLE grants (project TEXT PRIMARY KEY)"); db.close();
  expect(() => new GrantStore(foreign)).toThrow("grant_store_denied");
  const tampered = fresh();
  new GrantStore(tampered).close();
  const raw = new Database(tampered);
  raw.prepare("INSERT INTO grants VALUES (?, ?, ?)").run("../etc", "2026-11-09T00:00:00.000Z", "local_operator:0123456789abcdef"); raw.close();
  expect(() => new GrantStore(tampered)).toThrow("grant_store_denied");
  const store = new GrantStore(fresh());
  expect(() => store.grant("Bad Name", audit())).toThrow("invalid_project");
  expect(() => store.grant("alpha", { ...audit(), actor: "cookie=secret" })).toThrow("invalid_grant_audit");
  for (let i = 0; i < MAX_UI_GRANTS; i++) store.grant(`p${i}`, audit());
  expect(() => store.grant("one-too-many", audit())).toThrow("grant_limit_reached");
  store.close();
});

test("grants: configuration ∪ UI, reserved never grantable, configuration never revocable, ONE live set for every principal", () => {
  const store = new GrantStore(fresh());
  const grants = ProjectGrants.managed({ config: ["beta"], reserved: reservedProjects("secret-lab"), store });
  expect([...grants.view]).toEqual(["beta"]);
  expect(DEFAULT_RESERVED_PROJECTS).toEqual(["engineering-cockpit"]);
  expect(() => grants.grant("engineering-cockpit", audit())).toThrow("project_reserved");
  expect(() => grants.grant("secret-lab", audit())).toThrow("project_reserved");
  expect(grants.grant("beta", audit())).toBe(false); // already granted by configuration: no UI grant, no audit row
  expect(store.list()).toEqual([]);
  const security = new LocalSecurity(credential, grants);
  const session = security.login(credential);
  const principal = security.authenticate(`cockpit_session=${session.cookie}`, session.proof);
  expect(principal.grants.has("alpha")).toBe(false);
  expect(grants.grant("alpha", audit(2))).toBe(true);
  expect(principal.grants.has("alpha")).toBe(true); // a principal taken BEFORE the change sees it
  expect(grants.source("alpha")).toBe("ui");
  expect(() => grants.revoke("beta", audit(3))).toThrow("grant_from_config");
  expect(() => grants.revoke("nobody", audit(3))).toThrow("resource_not_found");
  expect(grants.revoke("alpha", audit(4))).toBe(true);
  expect(principal.grants.has("alpha")).toBe(false); // revocation applies to existing sessions at once
  expect(security.auditActor(principal)).toMatch(/^local_operator:[a-f0-9]{16}$/);
  expect(security.auditActor(principal)).not.toContain(session.cookie.slice(0, 16));
  store.close();
});

test("grants: a stored UI grant of a project now reserved or now in the configuration is removed at start, audited, and never revived", () => {
  // Independent security review, finding 1 (reproduced before the fix): such rows stayed dormant, unrevocable from the UI, and
  // came back silently once the configuration changed again.
  const path = fresh();
  const store = new GrantStore(path);
  store.grant("alpha", audit(1)); store.grant("gamma", audit(2)); store.grant("delta", audit(3));
  const grants = ProjectGrants.managed({ config: ["gamma"], reserved: reservedProjects("alpha"), store });
  expect(grants.shadowedAtStart).toEqual(["alpha", "gamma"]);
  expect([...grants.view]).toEqual(["delta", "gamma"]);
  expect(grants.source("gamma")).toBe("config");
  expect(grants.source("alpha")).toBeNull();
  expect(store.list().map(row => row.project)).toEqual(["delta"]);
  expect(store.audit().slice(0, 2).map(row => [row.action, row.project, row.actor, row.requestId])).toEqual([
    ["revoke", "gamma", "system:0000000000000000", "startup-reconcile"], ["revoke", "alpha", "system:0000000000000000", "startup-reconcile"]]);
  // The configuration goes back to empty and nothing is reserved any more: neither project returns.
  const later = ProjectGrants.managed({ config: [], reserved: reservedProjects(undefined), store });
  expect([...later.view]).toEqual(["delta"]);
  expect(later.shadowedAtStart).toEqual([]);
  store.close();
});

test("store: an empty private file (first start died before the schema was written) is initialised, not a permanent refusal", async () => {
  // Independent security review, finding 3 (reproduced before the fix).
  const path = fresh();
  await writeFile(path, "", { mode: 0o600 });
  const store = new GrantStore(path);
  expect(store.list()).toEqual([]);
  expect(store.grant("alpha", audit())).toBe(true);
  store.close();
  expect(new GrantStore(path).list().map(row => row.project)).toEqual(["alpha"]);
});

test("grants: legacy fixed list stays non-empty and read-only; startup inputs are validated", () => {
  expect(() => new LocalSecurity(credential, [])).toThrow("local_grants_required");
  expect(() => new LocalSecurity(credential, ["Demo"])).toThrow("local_grants_required");
  const fixed = ProjectGrants.fixed(["demo"]);
  expect(fixed.mutable).toBe(false);
  expect(() => fixed.grant("lab", audit())).toThrow("grants_read_only");
  expect(() => LocalSecurity.assertCredential("short")).toThrow("local_credential_required");
  expect(() => reservedProjects("a,a")).toThrow("invalid_reserved_projects");
  expect(() => ProjectGrants.validateConfig(["x", "x"], [])).toThrow("local_grants_required");
});

test("config: empty or unset COCKPIT_ALLOWED_PROJECTS means no configuration grant; UI grants are on by default, off on request", () => {
  const base = { COCKPIT_LOCAL_TOKEN: credential, COCKPIT_DATA_DIR: "/srv/cockpit-data" };
  expect(config(base).allowedProjects).toEqual([]);
  expect(config({ ...base, COCKPIT_ALLOWED_PROJECTS: "" }).allowedProjects).toEqual([]);
  expect(config({ ...base, COCKPIT_ALLOWED_PROJECTS: "demo,lab" }).allowedProjects).toEqual(["demo", "lab"]);
  expect(config({ ...base, COCKPIT_ALLOWED_PROJECTS: "demo," }).allowedProjects).toEqual(["demo", ""]); // still refused by the grants
  expect(config(base).grantsDatabasePath).toBe("/srv/cockpit-data/runtime-mock/grants.sqlite"); // inside the private runtime directory
  expect(config({ ...base, COCKPIT_UI_GRANTS: "off" }).grantsDatabasePath).toBeNull();
  expect(() => config({ ...base, COCKPIT_UI_GRANTS: "yes" })).toThrow("invalid_ui_grants");
  expect(config({ ...base, COCKPIT_RESERVED_PROJECTS: "secret-lab" }).reservedProjects).toEqual(["engineering-cockpit", "secret-lab"]);
  // The service accepts an empty configuration only while UI grants are on.
  const service = { COCKPIT_MODE: "mock", PORT: "8787", COCKPIT_LOCAL_TOKEN_FILE: "/home/op/.config/engineering-cockpit/token" };
  expect(validateSettings({ ...service, COCKPIT_ALLOWED_PROJECTS: "" }).allowedProjects).toEqual([]);
  expect(() => validateSettings({ ...service, COCKPIT_ALLOWED_PROJECTS: "", COCKPIT_UI_GRANTS: "off" })).toThrow("local_grants_required");
});

test("catalog: discovered directories and authorized projects only; per-provider status never implies creating or starting a VM", () => {
  const store = new GrantStore(fresh());
  const grants = ProjectGrants.managed({ config: ["beta", "gone"], reserved: reservedProjects(undefined), store });
  grants.grant("alpha", audit());
  const snapshot: Snapshot = { source: "host", host_verification: "not_verified", observed_at: "2026-11-09T12:00:00.000Z",
    projects: ["alpha", "beta", "delta", "engineering-cockpit"], vms: [
      { vm_name: "claude-alpha", provider: "claude", project: "alpha", state: "running", orphaned: false },
      { vm_name: "codex-alpha", provider: "codex", project: "alpha", state: "stopped", orphaned: false },
      { vm_name: "codex-delta", provider: "codex", project: "delta", state: "running", orphaned: false },
      { vm_name: "opencode-beta", provider: "opencode", project: "beta", state: "running", orphaned: false },
      { vm_name: "claude-engineering-cockpit", provider: "claude", project: "engineering-cockpit", state: "running", orphaned: false },
      { vm_name: "codex-ghost", provider: "codex", project: "ghost", state: "running", orphaned: true },
    ] };
  const execution = {
    supports: (provider: string, vm?: string) => (provider === "codex" || provider === "claude") && vm !== "claude-engineering-cockpit",
    unsupportedReason: (provider: string, vm: string) => vm === "claude-engineering-cockpit" ? "reserved" as const : provider === "opencode" ? "provider" as const : null,
  };
  const view = buildCatalog({ snapshot, discoveryError: null, grants, execution, source: "host" }) as { projects: Array<Record<string, any>>; counts: unknown };
  const byName = Object.fromEntries(view.projects.map(project => [project.name, project]));
  expect(Object.keys(byName)).toEqual(["alpha", "beta", "delta", "engineering-cockpit", "gone"]); // never "ghost": no directory, no grant
  const status = (name: string) => byName[name]!.agents.map((agent: { vm_name: string; status: string }) => `${agent.vm_name}:${agent.status}`);
  expect(status("alpha")).toEqual(["claude-alpha:ready", "codex-alpha:stopped"]);
  expect(byName.alpha).toMatchObject({ authorized: true, grant: "ui", can_revoke: true, can_authorize: false });
  expect(status("beta")).toEqual(["claude-beta:absent", "codex-beta:absent", "opencode-beta:unsupported"]);
  expect(byName.beta).toMatchObject({ grant: "config", can_revoke: false });
  expect(status("delta")).toEqual(["claude-delta:absent", "codex-delta:not_authorized"]);
  expect(byName.delta).toMatchObject({ authorized: false, can_authorize: true });
  expect(status("engineering-cockpit")).toEqual(["claude-engineering-cockpit:reserved", "codex-engineering-cockpit:absent"]);
  expect(byName["engineering-cockpit"]).toMatchObject({ reserved: true, can_authorize: false });
  expect(byName.gone).toMatchObject({ present: false, authorized: true });
  expect(status("gone")).toEqual(["claude-gone:project_missing", "codex-gone:project_missing"]);
  expect(view.counts).toEqual({ discovered: 4, authorized: 3 });
  const blind = buildCatalog({ snapshot: null, discoveryError: "msb_timeout", grants, execution, source: "host" }) as { projects: Array<Record<string, any>> };
  expect(blind.projects.map(project => project.name)).toEqual(["alpha", "beta", "gone"]); // only what is authorized; nothing can be authorized blind
  expect(blind.projects.every(project => project.present === null && project.can_authorize === false)).toBe(true);
  store.close();
});

test("data directory: the grants file lives in the private runtime directory (0700, ours); a shared directory is refused", async () => {
  const dir = join(work, "data-dir");
  await mkdir(join(dir, "runtime-mock"), { recursive: true, mode: 0o700 });
  const settings = config({ COCKPIT_LOCAL_TOKEN: credential, COCKPIT_DATA_DIR: dir });
  const store = new GrantStore(settings.grantsDatabasePath!);
  store.close();
  expect((await stat(join(dir, "runtime-mock", "grants.sqlite"))).isFile()).toBe(true);
  const shared = join(work, "shared-dir");
  await mkdir(shared, { mode: 0o700 });
  await chmod(shared, 0o755);
  expect(() => new GrantStore(join(shared, "grants.sqlite"))).toThrow("grant_store_denied");
  expect(await Bun.file(join(shared, "grants.sqlite")).exists()).toBe(false); // refused before anything is created
});

test("store: a planted hot journal / WAL (shared mode, extra link, not a file) is refused BEFORE SQLite could replay it", async () => {
  // Independent security review round 2, finding F2 (reproduced before the fix): a foreign `-journal` next to the store was
  // rolled back into it on open, injecting a grant with no audit row.
  for (const [suffix, plant] of [
    ["-journal", async (path: string) => { await writeFile(path, "x", { mode: 0o644 }); await chmod(path, 0o644); }],
    ["-wal", async (path: string) => { await writeFile(path, "x", { mode: 0o600 }); await link(path, path + ".second"); }],
    ["-shm", async (path: string) => { await mkdir(path, { mode: 0o700 }); }],
  ] as const) {
    const path = fresh();
    new GrantStore(path).close();
    await plant(path + suffix);
    expect(() => new GrantStore(path)).toThrow("grant_store_denied");
  }
  // A private regular sidecar of ours (a real crash leftover) is still accepted.
  const path = fresh();
  new GrantStore(path).close();
  await writeFile(path + "-journal", "", { mode: 0o600 });
  expect(() => new GrantStore(path).close()).not.toThrow();
});

test("store: a swap of the file at ANY point of the open sequence is refused or harmless (never a planted store opened)", async () => {
  // Independent verification round 4, F1 (reproduced before the fix): the pinned dev/inode came from a stat that had not been
  // checked, so a store swapped between the checks and the pin was opened. Each lstat of the path is tried as the swap point.
  const results: Array<{ n: number; outcome: string; swapped: boolean; grants?: string[]; code?: string }> = [];
  for (let n = 1; n <= 6; n++) {
    const dir = join(work, `swap-${n}`);
    await mkdir(dir, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, "--no-env-file", new URL("./support/grant-store-swap.ts", import.meta.url).pathname, dir, String(n)], { stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    results.push(JSON.parse(out.trim().split("\n").at(-1)!));
  }
  expect(results.some(result => result.swapped)).toBe(true); // the swap really happened in the sequence
  for (const result of results) {
    if (result.outcome === "opened") expect(result.grants).not.toContain("evilproj");
    else expect(result.code).toBe("grant_store_denied");
  }
});

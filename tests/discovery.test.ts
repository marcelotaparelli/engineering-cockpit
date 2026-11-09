import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { parseVmList } from "../src/parser.ts";
import { validProject, vmIdentity, type Snapshot } from "../src/model.ts";
import { listProjects } from "../src/projects.ts";
import { SnapshotStore } from "../src/store.ts";
import { Discovery, mockOutput } from "../src/discovery.ts";
import { config } from "../src/config.ts";

const temp = await mkdtemp(join(tmpdir(), "cockpit-tests-"));
const stores: SnapshotStore[] = [];
afterAll(() => { for (const store of stores) { try { store.close(); } catch {} } });
function store(name: string) { const result = new SnapshotStore(join(temp, name)); stores.push(result); return result; }
function snapshot(): Snapshot {
  return { source: "mock", observed_at: "2026-10-25T00:00:00.000Z", host_verification: "not_verified", projects: ["demo"], vms: [{ vm_name: "codex-demo", provider: "codex", project: "demo", state: "running", orphaned: false }] };
}
describe("synthetic parser contract (installed msb remains not_verified)", () => {
  test("legacy table and schema-shaped JSON fixtures agree", async () => {
    const table = parseVmList(await mockOutput());
    const json = parseVmList(await Bun.file(new URL("../fixtures/msb/synthetic-json.json", import.meta.url)).text());
    expect(table).toEqual(json);
    expect(table[2]?.state).toBe("stopped");
    expect(parseVmList("NAME STATE\ncodex-demo running")[0]?.state).toBe("running");
  });
  test("documented empty inventories", () => {
    expect(parseVmList("NAME STATUS")).toEqual([]);
    expect(parseVmList("[]")).toEqual([]);
  });
  test("MSB 0.6.8 JSON contract normalizes Running/Stopped across six schema records", async () => {
    const rows = parseVmList(await Bun.file(new URL("../fixtures/msb/msb-0.6.8-six-records.json", import.meta.url)).text());
    expect(rows).toHaveLength(6);
    expect(rows.map(row => row.state)).toEqual(["running", "stopped", "running", "stopped", "running", "stopped"]);
    expect(rows[0]).toEqual({ vm_name: "claude-catus-2026", provider: "claude", project: "catus-2026", state: "running", orphaned: false });
  });
  test.each([
    "", " \n", "No VMs found", "NAME OTHER\ncodex-demo running", "NAME STATUS IMAGE\ncodex-demo running",
    "NAME STATUS\ncodex-demo running extra", "NAME STATUS\ncodex-demo running\n\nclaude-demo stopped",
    "NAME STATUS\ncodex-demo running\ncodex-demo stopped", '[{"created_at":"2026-10-25T13:54:12.860454803+00:00","image":"node:22-bookworm-slim","name":"codex-demo","status":"Running"},{"created_at":"2026-10-25T13:54:13.000000000+00:00","image":"node:22-bookworm-slim","name":"codex-demo","status":"Stopped"}]',
    "{}", "[invalid]", '[{"name":"codex-demo"}]', '[{"name":"codex-demo","status":""}]', '[{"name":"other-demo","status":"running"}]',
    "NAME STATUS\ncodex-demo paused", "NAME STATUS\ncodex-demo RUNNING",
    '[{"created_at":"2026-10-25T13:54:12Z","image":"node:22","name":"codex-demo","status":"Paused"}]',
    '[{"created_at":"2026-10-25T13:54:12Z","image":"node:22","name":"codex-demo","status":"running"}]',
    '[{"created_at":"invalid","image":"node:22","name":"codex-demo","status":"Running"}]',
    '[{"created_at":"2026-99-88T13:54:12Z","image":"node:22","name":"codex-demo","status":"Running"}]',
    '[{"created_at":"2026-10-25T13:54:12Z","image":"","name":"codex-demo","status":"Running"}]',
    '[{"created_at":"2026-10-25T13:54:12Z","image":"node:22","name":"codex-demo","status":"Running","extra":true}]',
    '[{"created_at":"2026-10-25T13:54:12Z","name":"codex-demo","status":"Running"}]',
  ])("rejects malformed/unknown inventory %s", output => { expect(() => parseVmList(output)).toThrow(); });
});
test("conservative names", () => {
  for (const name of ["demo", "a", "demo-2", "a_b"]) expect(validProject(name)).toBe(true);
  for (const name of ["../demo", "/tmp", ".", "Demo", "a b", "a;id", "a/../b", "a".repeat(64), ""]) {
    expect(validProject(name)).toBe(false);
    expect(() => vmIdentity(`codex-${name}`)).toThrow();
  }
  expect(() => vmIdentity("arbitrary-demo")).toThrow();
});
test("project discovery lists only direct real directories, never content or symlinks", async () => {
  const base = join(temp, "projects");
  await mkdir(base);
  await mkdir(join(base, "demo"));
  await mkdir(join(base, "Demo"));
  await writeFile(join(base, "file"), "not a directory");
  await writeFile(join(base, "demo", "secret"), "never read");
  await symlink(join(base, "demo"), join(base, "linked"));
  expect(await listProjects(base)).toEqual(["demo"]);
  const link = join(temp, "project-link");
  await symlink(base, link);
  expect(listProjects(link)).rejects.toThrow("symlink_path_denied");
  expect(listProjects(join(link, "demo"))).rejects.toThrow("symlink_path_denied");
  expect(listProjects(join(temp, "missing"))).rejects.toThrow("project_discovery_failed");
});
test("sqlite snapshot persists, transaction rolls back, empty replaces previous, reopen works", () => {
  const db = store("snapshot.sqlite");
  expect(db.read()).toBeNull();
  db.replace(snapshot());
  expect(db.read()).toEqual(snapshot());
  expect(() => db.replace({ ...snapshot(), projects: ["demo", "demo"] })).toThrow();
  expect(db.read()).toEqual(snapshot());
  db.close();
  const reopened = store("snapshot.sqlite");
  expect(reopened.read()).toEqual(snapshot());
  reopened.replace({ ...snapshot(), projects: [], vms: [] });
  expect(reopened.read()?.vms).toEqual([]);
  expect(reopened.read()?.projects).toEqual([]);
});
test("SQLite v1 migrates in place and v2 persists orphan status without fictional projects", () => {
  const path = join(temp, "legacy-v1.sqlite");
  const legacy = new Database(path, { create: true });
  legacy.exec(`
    PRAGMA application_id=1129268043;
    PRAGMA user_version=1;
    CREATE TABLE projects (name TEXT PRIMARY KEY);
    CREATE TABLE vm_registry (vm_name TEXT PRIMARY KEY, provider TEXT NOT NULL, project TEXT NOT NULL REFERENCES projects(name), state TEXT NOT NULL);
    CREATE TABLE snapshot_meta (id INTEGER PRIMARY KEY CHECK(id=1), source TEXT NOT NULL, observed_at TEXT NOT NULL, host_verification TEXT NOT NULL);
    INSERT INTO projects VALUES ('demo');
    INSERT INTO vm_registry VALUES ('codex-demo', 'codex', 'demo', 'running');
    INSERT INTO snapshot_meta VALUES (1, 'mock', '2026-10-25T00:00:00.000Z', 'not_verified');
  `);
  legacy.close();
  const migrated = store("legacy-v1.sqlite");
  expect(migrated.db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
  expect(migrated.read()?.vms[0]?.orphaned).toBe(false);
  const next = { ...snapshot(), vms: [{ vm_name: "codex-absent", provider: "codex" as const, project: "absent", state: "stopped" as const, orphaned: true }, ...snapshot().vms] };
  migrated.replace(next);
  expect(migrated.read()).toEqual(next);
  expect(migrated.read()?.projects).not.toContain("absent");
  expect(() => migrated.replace({ ...next, vms: next.vms.map(vm => ({ ...vm, orphaned: false })) })).toThrow("snapshot_orphan_mismatch");
});
test("sqlite rejects symlinks and unrelated database without modifying it", async () => {
  const alien = join(temp, "alien.sqlite");
  const original = new Database(alien, { create: true });
  original.exec("CREATE TABLE projects (name TEXT); INSERT INTO projects VALUES ('preserve')");
  original.close();
  expect(() => new SnapshotStore(alien)).toThrow("foreign_database_denied");
  const check = new Database(alien);
  expect(check.query("SELECT name FROM projects").get()).toEqual({ name: "preserve" });
  check.close();
  const link = join(temp, "db-link.sqlite");
  await symlink(alien, link);
  expect(() => new SnapshotStore(link)).toThrow("symlink_path_denied");
});
test("SQLite read fails closed on semantically tampered VM rows", () => {
  const db = store("tampered.sqlite");
  db.replace(snapshot());
  db.db.exec("UPDATE vm_registry SET provider='claude'");
  expect(() => db.read()).toThrow("foreign_database_denied");
});
test("discovery keeps valid orphan VMs without inventing projects and preserves storage after failure", async () => {
  const db = store("discovery.sqlite");
  let output = "NAME STATUS\ncodex-demo running\ncodex-absent running";
  const discovery = new Discovery({ source: "mock", projectsBase: new URL("../fixtures/projects", import.meta.url).pathname, store: db, readOutput: async () => output });
  const current = await discovery.refresh();
  expect(current.projects).toEqual(["demo", "lab", "vault"]);
  expect(current.vms.map(vm => [vm.vm_name, vm.orphaned])).toEqual([["codex-absent", true], ["codex-demo", false]]);
  expect(current.projects).not.toContain("absent");
  output = "bad format";
  expect(discovery.refresh()).rejects.toThrow("unsupported_vm_format");
  expect(db.read()).toEqual(current);
});
test("concurrent discovery requests share one complete observation and retry after failure", async () => {
  const db = store("concurrent.sqlite");
  let calls = 0;
  let release: ((output: string) => void) | undefined;
  const discovery = new Discovery({ source: "mock", projectsBase: new URL("../fixtures/projects", import.meta.url).pathname, store: db, readOutput: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const first = discovery.refresh();
  const second = discovery.refresh();
  expect(first).toBe(second);
  while (!release) await Bun.sleep(1);
  release("bad format");
  const failures = await Promise.allSettled([first, second]);
  expect(failures.every(result => result.status === "rejected")).toBe(true);
  expect(calls).toBe(1);
  release = undefined;
  const retry = discovery.refresh();
  while (!release) await Bun.sleep(1);
  const finish = release as (output: string) => void;
  finish("[]");
  expect((await retry).vms).toEqual([]);
  expect(calls).toBe(2);
});
test("mock is default, host needs explicit dual opt-in and absolute project base; ports validated", () => {
  expect(config({}).source).toBe("mock");
  expect(config({}).port).toBe(0);
  expect(config({ COCKPIT_HOST_CONFIRMED: "yes" }).source).toBe("mock");
  expect(() => config({ COCKPIT_MODE: "host" })).toThrow("host_confirmation_required");
  expect(() => config({ COCKPIT_MODE: "host", COCKPIT_HOST_CONFIRMED: "yes" })).toThrow("host_projects_base_required");
  const host = config({ COCKPIT_MODE: "host", COCKPIT_HOST_CONFIRMED: "yes", COCKPIT_PROJECTS_BASE: "/explicit/projects" });
  expect(host.databasePath).not.toBe(config({}).databasePath);
  for (const PORT of ["-1", "65536", "1x", "01", "", "1.2"]) expect(() => config({ PORT })).toThrow("invalid_port");
});
test("E1: cached() spares MSB for display reads but refresh() always observes and errors are never cached", async () => {
  const db = store("cache.sqlite");
  let calls = 0;
  let output = "NAME STATUS\ncodex-demo running";
  const discovery = new Discovery({ source: "mock", projectsBase: new URL("../fixtures/projects", import.meta.url).pathname, store: db, readOutput: async () => { calls += 1; return output; } });
  const first = await discovery.cached(60_000);
  expect(await discovery.cached(60_000)).toBe(first);
  expect(calls).toBe(1);
  output = "NAME STATUS\ncodex-demo stopped";
  expect((await discovery.cached(60_000)).vms[0]?.state).toBe("running"); // display may be briefly stale…
  expect((await discovery.refresh()).vms[0]?.state).toBe("stopped"); // …dispatch decisions never are
  expect(calls).toBe(2);
  expect((await discovery.cached(60_000)).vms[0]?.state).toBe("stopped"); // refresh feeds the cache
  expect((await discovery.cached(0)).vms[0]?.state).toBe("stopped");
  expect(calls).toBe(3);
  output = "bad format";
  await expect(discovery.cached(0)).rejects.toThrow("unsupported_vm_format");
  await expect(discovery.cached(60_000)).resolves.toBeDefined(); // last good snapshot only within TTL; failure itself was not stored
  expect(calls).toBe(4);
});

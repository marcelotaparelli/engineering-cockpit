import { Database } from "bun:sqlite";
import { closeSync, lstatSync, openSync } from "node:fs";
import type { Snapshot, Vm } from "./model.ts";
import { SafeError, validProject, vmIdentity } from "./model.ts";
import { assertNoSymlinks } from "./paths.ts";

const applicationId = 0x434f434b;
const schemaV1 = [
  "CREATE TABLE projects (name TEXT PRIMARY KEY)",
  "CREATE TABLE vm_registry (vm_name TEXT PRIMARY KEY, provider TEXT NOT NULL, project TEXT NOT NULL REFERENCES projects(name), state TEXT NOT NULL)",
  "CREATE TABLE snapshot_meta (id INTEGER PRIMARY KEY CHECK(id=1), source TEXT NOT NULL, observed_at TEXT NOT NULL, host_verification TEXT NOT NULL)",
];
const schema = [
  "CREATE TABLE projects (name TEXT PRIMARY KEY)",
  "CREATE TABLE vm_registry (vm_name TEXT PRIMARY KEY, provider TEXT NOT NULL, project TEXT NOT NULL, state TEXT NOT NULL, orphaned INTEGER NOT NULL CHECK(orphaned IN (0, 1)))",
  "CREATE TABLE snapshot_meta (id INTEGER PRIMARY KEY CHECK(id=1), source TEXT NOT NULL, observed_at TEXT NOT NULL, host_verification TEXT NOT NULL)",
];
const normalizeSql = (sql: string) => sql.replace(/\s+/g, " ").trim();
const expectedSchema = (value: string[]) => value.map(normalizeSql).sort();

export class SnapshotStore {
  readonly db: Database;
  constructor(path: string) {
    assertNoSymlinks(path);
    for (const suffix of ["-wal", "-shm", "-journal"]) assertNoSymlinks(path + suffix);
    let created = false;
    try {
      const file = lstatSync(path);
      if (!file.isFile() || file.nlink !== 1) throw new SafeError("unsafe_database_file");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      closeSync(openSync(path, "wx", 0o600));
      created = true;
    }
    this.db = new Database(path, { strict: true });
    try {
      if (created) {
        this.db.transaction(() => {
          this.db.exec(`PRAGMA application_id=${applicationId}; PRAGMA user_version=2;`);
          for (const sql of schema) this.db.exec(sql);
        })();
      } else {
        const identity = this.db.query("PRAGMA application_id").get() as { application_id: number };
        const version = this.db.query("PRAGMA user_version").get() as { user_version: number };
        const tables = this.db.query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all() as { sql: string }[];
        const actual = tables.map(row => normalizeSql(row.sql)).sort();
        if (identity.application_id !== applicationId) throw new SafeError("foreign_database_denied");
        if (version.user_version === 1 && JSON.stringify(expectedSchema(schemaV1)) === JSON.stringify(actual)) {
          this.db.transaction(() => {
            this.db.exec("CREATE TABLE vm_registry_migration (vm_name TEXT PRIMARY KEY, provider TEXT NOT NULL, project TEXT NOT NULL, state TEXT NOT NULL, orphaned INTEGER NOT NULL CHECK(orphaned IN (0, 1))); INSERT INTO vm_registry_migration SELECT vm_name, provider, project, state, CASE WHEN project IN (SELECT name FROM projects) THEN 0 ELSE 1 END FROM vm_registry; DROP TABLE vm_registry; CREATE TABLE vm_registry (vm_name TEXT PRIMARY KEY, provider TEXT NOT NULL, project TEXT NOT NULL, state TEXT NOT NULL, orphaned INTEGER NOT NULL CHECK(orphaned IN (0, 1))); INSERT INTO vm_registry SELECT * FROM vm_registry_migration; DROP TABLE vm_registry_migration; PRAGMA user_version=2;");
          })();
        } else if (version.user_version !== 2 || JSON.stringify(expectedSchema(schema)) !== JSON.stringify(actual)) {
          throw new SafeError("foreign_database_denied");
        }
      }
      this.db.exec("PRAGMA foreign_keys=ON;");
    } catch (error) { this.db.close(); throw error; }
  }
  replace(snapshot: Snapshot): void {
    const projects = new Set(snapshot.projects);
    if (snapshot.vms.some(row => row.orphaned !== !projects.has(row.project))) throw new SafeError("snapshot_orphan_mismatch");
    this.db.transaction(() => {
      this.db.exec("DELETE FROM vm_registry; DELETE FROM projects; DELETE FROM snapshot_meta;");
      const project = this.db.prepare("INSERT INTO projects(name) VALUES (?)");
      for (const name of snapshot.projects) project.run(name);
      const vm = this.db.prepare("INSERT INTO vm_registry VALUES (?, ?, ?, ?, ?)");
      for (const row of snapshot.vms) vm.run(row.vm_name, row.provider, row.project, row.state, row.orphaned ? 1 : 0);
      this.db.prepare("INSERT INTO snapshot_meta VALUES (1, ?, ?, ?)").run(snapshot.source, snapshot.observed_at, snapshot.host_verification);
    })();
  }
  read(): Snapshot | null {
    const meta = this.db.query("SELECT source, observed_at, host_verification FROM snapshot_meta WHERE id=1").get() as Pick<Snapshot, "source" | "observed_at" | "host_verification"> | null;
    if (!meta) return null;
    const projects = (this.db.query("SELECT name FROM projects ORDER BY name").all() as { name: string }[]).map(row => row.name);
    const rows = this.db.query("SELECT * FROM vm_registry ORDER BY vm_name").all() as (Omit<Vm, "orphaned"> & { orphaned: number })[];
    try {
      if ((meta.source !== "mock" && meta.source !== "host") || meta.host_verification !== "not_verified" || !Number.isFinite(Date.parse(meta.observed_at)) || projects.some(name => !validProject(name))) throw new Error();
      const knownProjects = new Set(projects);
      const vms = rows.map(row => {
        const identity = vmIdentity(row.vm_name);
        if (identity.provider !== row.provider || identity.project !== row.project || !["running", "stopped", "unknown"].includes(row.state)
          || (row.orphaned !== 0 && row.orphaned !== 1) || (row.orphaned === 1) !== !knownProjects.has(row.project)) throw new Error();
        return { ...row, orphaned: row.orphaned === 1 };
      });
      return { ...meta, projects, vms };
    } catch { throw new SafeError("foreign_database_denied"); }
  }
  close(): void { this.db.close(); }
}

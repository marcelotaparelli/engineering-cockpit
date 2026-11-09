import { Database } from "bun:sqlite";
import { closeSync, lstatSync, openSync } from "node:fs";
import { SafeError, validProject } from "./model.ts";
import { assertNoSymlinks } from "./paths.ts";

/**
 * Project authorizations granted from the authenticated UI (never from discovery alone), with an append-only audit trail.
 * Its own SQLite file in the data directory: private (0600, created O_EXCL), never through a link, a single hard link,
 * identified by application_id and an exact schema. Anything else is refused (`grant_store_denied`): fail closed, no repair.
 */
const APPLICATION_ID = 0x43475254; // "CGRT"
const VERSION = 1;
const SCHEMA = [
  "CREATE TABLE grants (project TEXT PRIMARY KEY, granted_at TEXT NOT NULL, actor TEXT NOT NULL)",
  "CREATE TABLE grant_audit (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('grant', 'revoke')), project TEXT NOT NULL, actor TEXT NOT NULL, request_id TEXT NOT NULL)",
  "CREATE TRIGGER grant_audit_append_only_update BEFORE UPDATE ON grant_audit BEGIN SELECT RAISE(ABORT, 'grant_audit_append_only'); END",
  "CREATE TRIGGER grant_audit_append_only_delete BEFORE DELETE ON grant_audit BEGIN SELECT RAISE(ABORT, 'grant_audit_append_only'); END",
];
/** Upper bound of UI grants: keeps the catalog and every per-request set bounded. */
export const MAX_UI_GRANTS = 256;
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
const ACTOR = /^[a-z_]+:[a-f0-9]{16}$/;
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface GrantAudit { actor: string; requestId: string; at: string }
export interface GrantRow { project: string; grantedAt: string; actor: string }
export interface AuditRow { seq: number; at: string; action: "grant" | "revoke"; project: string; actor: string; requestId: string }

export class GrantStore {
  readonly #db: Database;

  constructor(path: string) {
    if (!path.startsWith("/") || path.split("/").includes("..")) throw new SafeError("grant_store_denied");
    assertNoSymlinks(path);
    for (const suffix of ["-wal", "-shm", "-journal"]) assertNoSymlinks(path + suffix);
    let created = false;
    try {
      const file = lstatSync(path);
      const uid = process.getuid?.();
      if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o077) !== 0 || (uid !== undefined && file.uid !== uid)) throw new SafeError("grant_store_denied");
      // A first start that died between creating the file and writing its schema leaves an empty private file: initialise it
      // (an empty file holds no grant, so nothing is lost or widened) instead of refusing every later start.
      if (file.size === 0) created = true;
    } catch (error) {
      if (error instanceof SafeError) throw error;
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw new SafeError("grant_store_denied");
      closeSync(openSync(path, "wx", 0o600));
      created = true;
    }
    this.#db = new Database(path, { strict: true });
    try {
      if (created) {
        this.#db.transaction(() => {
          this.#db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${VERSION};`);
          for (const sql of SCHEMA) this.#db.exec(sql);
        })();
      } else {
        const identity = this.#db.query("PRAGMA application_id").get() as { application_id: number };
        const version = this.#db.query("PRAGMA user_version").get() as { user_version: number };
        const actual = (this.#db.query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all() as { sql: string }[]).map(row => normalize(row.sql)).sort();
        if (identity.application_id !== APPLICATION_ID || version.user_version !== VERSION || JSON.stringify(actual) !== JSON.stringify(SCHEMA.map(normalize).sort())) {
          throw new SafeError("grant_store_denied");
        }
      }
      this.list(); // validates every stored row now: a tampered file refuses startup instead of failing later
    } catch (error) {
      this.#db.close();
      throw error instanceof SafeError ? error : new SafeError("grant_store_denied");
    }
  }

  list(): GrantRow[] {
    const rows = this.#db.query("SELECT project, granted_at, actor FROM grants ORDER BY project").all() as { project: string; granted_at: string; actor: string }[];
    if (rows.length > MAX_UI_GRANTS || rows.some(row => !validProject(row.project) || !ISO.test(row.granted_at) || !ACTOR.test(row.actor))) throw new SafeError("grant_store_denied");
    return rows.map(row => ({ project: row.project, grantedAt: row.granted_at, actor: row.actor }));
  }

  /** Adds a grant and its audit row atomically. False (and no audit row) when it already exists. */
  grant(project: string, audit: GrantAudit): boolean {
    check(project, audit);
    return this.#db.transaction(() => {
      if (this.#db.query("SELECT 1 FROM grants WHERE project=?").get(project)) return false;
      const count = (this.#db.query("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n;
      if (count >= MAX_UI_GRANTS) throw new SafeError("grant_limit_reached");
      this.#db.prepare("INSERT INTO grants VALUES (?, ?, ?)").run(project, audit.at, audit.actor);
      this.#db.prepare("INSERT INTO grant_audit(at, action, project, actor, request_id) VALUES (?, 'grant', ?, ?, ?)").run(audit.at, project, audit.actor, audit.requestId);
      return true;
    })();
  }

  /**
   * Startup reconciliation: removes stored UI grants that can no longer be UI grants (project now reserved, or now granted by
   * the configuration), each with a `revoke` audit row. A later configuration change can therefore never revive them silently.
   */
  dropShadowed(isShadowed: (project: string) => boolean, audit: GrantAudit): string[] {
    return this.#db.transaction(() => {
      const dropped = this.list().map(row => row.project).filter(isShadowed);
      for (const project of dropped) {
        check(project, audit);
        this.#db.prepare("DELETE FROM grants WHERE project=?").run(project);
        this.#db.prepare("INSERT INTO grant_audit(at, action, project, actor, request_id) VALUES (?, 'revoke', ?, ?, ?)").run(audit.at, project, audit.actor, audit.requestId);
      }
      return dropped;
    })();
  }

  /** Removes a grant and records it atomically. False (and no audit row) when there was none. */
  revoke(project: string, audit: GrantAudit): boolean {
    check(project, audit);
    return this.#db.transaction(() => {
      if (!this.#db.query("SELECT 1 FROM grants WHERE project=?").get(project)) return false;
      this.#db.prepare("DELETE FROM grants WHERE project=?").run(project);
      this.#db.prepare("INSERT INTO grant_audit(at, action, project, actor, request_id) VALUES (?, 'revoke', ?, ?, ?)").run(audit.at, project, audit.actor, audit.requestId);
      return true;
    })();
  }

  audit(limit = 100): AuditRow[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new SafeError("invalid_limit");
    const rows = this.#db.query("SELECT seq, at, action, project, actor, request_id FROM grant_audit ORDER BY seq DESC LIMIT ?").all(limit) as
      { seq: number; at: string; action: "grant" | "revoke"; project: string; actor: string; request_id: string }[];
    return rows.map(row => ({ seq: row.seq, at: row.at, action: row.action, project: row.project, actor: row.actor, requestId: row.request_id }));
  }

  close(): void { this.#db.close(); }
}

function check(project: string, audit: GrantAudit): void {
  if (!validProject(project)) throw new SafeError("invalid_project");
  if (!ACTOR.test(audit.actor) || !REQUEST_ID.test(audit.requestId) || !ISO.test(audit.at)) throw new SafeError("invalid_grant_audit");
}

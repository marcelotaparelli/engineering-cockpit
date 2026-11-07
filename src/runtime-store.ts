import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { SafeError, validProject, vmIdentity } from "./model.ts";
import { assertNoSymlinks } from "./paths.ts";
import type { ExecutionTarget, RunStatus } from "./provider.ts";

const APPLICATION_ID = 0x4352544d;
const SCHEMA_VERSION = 2;
const RUN_STATUSES: readonly RunStatus[] = ["prepared", "dispatching", "running", "awaiting_approval", "completed", "failed", "interrupted", "unknown"];
const SCHEMA_V1 = [
  "CREATE TABLE sessions (session_id TEXT PRIMARY KEY, provider TEXT NOT NULL, project_id TEXT NOT NULL, vm_name TEXT NOT NULL, vm_instance_id TEXT, discovery_version TEXT NOT NULL, provider_session_id TEXT NOT NULL, created_at TEXT NOT NULL, last_observed_at TEXT NOT NULL, UNIQUE(provider, project_id, vm_name, provider_session_id))",
  "CREATE TABLE runs (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id), operation TEXT NOT NULL, provider_run_id TEXT, idempotency_key_hash TEXT NOT NULL, request_digest TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('prepared','dispatching','running','awaiting_approval','completed','failed','interrupted','unknown')), lifecycle_version INTEGER NOT NULL CHECK(lifecycle_version >= 1), execution_count INTEGER NOT NULL CHECK(execution_count = 1), created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, reason_code TEXT, UNIQUE(session_id, operation, idempotency_key_hash))",
  "CREATE TABLE journal (sequence INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, run_id TEXT REFERENCES runs(run_id), type TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL)",
];
// v2: approvals (no provider content), observed token metrics and session activity time.
const SCHEMA_V2_ADDITIONS = [
  "CREATE TABLE approvals (approval_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), action_type TEXT NOT NULL CHECK(action_type IN ('command','file_change')), action_digest TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','expired')), version INTEGER NOT NULL CHECK(version >= 1), created_at TEXT NOT NULL, expires_at TEXT NOT NULL, resolved_at TEXT, reason_code TEXT)",
  "CREATE TABLE run_metrics (run_id TEXT PRIMARY KEY REFERENCES runs(run_id), input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER, token_scope TEXT NOT NULL CHECK(token_scope IN ('not_measured','session_cumulative')), updated_at TEXT NOT NULL)",
  "CREATE INDEX approvals_by_status ON approvals(status, run_id)",
  "CREATE INDEX runs_by_session ON runs(session_id, created_at)",
];
const SCHEMA = [...SCHEMA_V1, ...SCHEMA_V2_ADDITIONS];

export interface SessionRecord {
  sessionId: string;
  target: ExecutionTarget;
  providerSessionId: string;
  createdAt: string;
  lastObservedAt: string;
}

export interface RunRecord {
  runId: string;
  sessionId: string;
  operation: string;
  providerRunId: string | null;
  idempotencyKeyHash: string;
  requestDigest: string;
  status: RunStatus;
  lifecycleVersion: number;
  executionCount: 1;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  reasonCode: string | null;
}

export interface BeginRunInput {
  runId: string;
  sessionId: string;
  operation?: "start_run";
  idempotencyKey: string;
  requestDigest: string;
  createdAt: string;
  /** When set, refuse a new run while another Cockpit run of this project is active (one writer per project). */
  exclusiveProject?: string;
}

export interface BeginRunResult { run: RunRecord; created: boolean }

export type JournalType = "run.prepared" | "run.dispatching" | "run.started" | "run.status_changed" | "run.recovery_unknown" | "operation.notice"
  | "approval.requested" | "approval.resolved" | "run.error";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";
export interface ApprovalRecord {
  approvalId: string;
  runId: string;
  actionType: "command" | "file_change";
  actionDigest: string;
  status: ApprovalStatus;
  version: number;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  reasonCode: string | null;
}
export interface RunMetrics {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  tokenScope: "not_measured" | "session_cumulative";
  durationMs: number | null;
  durationSource: "host_clock" | "not_measured";
}
export interface ProjectJournalRecord extends JournalRecord { sessionId: string | null; projectId: string | null }
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["prepared", "dispatching", "running", "awaiting_approval"];
export interface JournalInput {
  eventId: string;
  runId: string | null;
  type: JournalType;
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
}
export interface JournalRecord extends JournalInput { sequence: number }

const PAYLOAD_FIELDS: Readonly<Record<JournalType, readonly string[]>> = {
  "run.prepared": ["status"],
  "run.dispatching": ["status"],
  "run.started": ["status", "providerBound"],
  "run.status_changed": ["from", "to", "reasonCode"],
  "run.recovery_unknown": ["from", "to", "reasonCode"],
  "operation.notice": ["reasonCode"],
  "approval.requested": ["approvalId", "actionType", "status"],
  "approval.resolved": ["approvalId", "status", "reasonCode"],
  "run.error": ["reasonCode"],
};

function normalizedSql(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function safeFile(path: string): void {
  assertNoSymlinks(path);
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.nlink !== 1) throw new SafeError("unsafe_database_file");
  } catch (error) { if (!isMissing(error)) throw error; }
}
function validId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value); }
function requireId(value: string): void { if (!validId(value)) throw new SafeError("invalid_runtime_id"); }
function requireTime(value: string): void { if (!value || !Number.isFinite(Date.parse(value))) throw new SafeError("invalid_runtime_timestamp"); }
function requireDigest(value: string): void { if (!/^[a-f0-9]{64}$/.test(value)) throw new SafeError("invalid_request_digest"); }
function keyHash(value: string): string {
  if (!value || value.length > 512 || value.includes("\0")) throw new SafeError("invalid_idempotency_key");
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function canonicalPayload(type: JournalType, payload: Readonly<Record<string, unknown>>): string {
  const allowed = PAYLOAD_FIELDS[type];
  const keys = Object.keys(payload).sort();
  if (keys.some(key => !allowed.includes(key))) throw new SafeError("journal_payload_denied");
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string") {
      if (value.length > 128 || /[\r\n\0]/.test(value)) throw new SafeError("journal_payload_denied");
      result[key] = value;
    } else if (typeof value === "boolean" || value === null) result[key] = value;
    else if (typeof value === "number" && Number.isSafeInteger(value)) result[key] = value;
    else throw new SafeError("journal_payload_denied");
  }
  return JSON.stringify(result);
}

type RunRow = {
  run_id: string; session_id: string; operation: string; provider_run_id: string | null;
  idempotency_key_hash: string; request_digest: string; status: string; lifecycle_version: number;
  execution_count: number; created_at: string; started_at: string | null; ended_at: string | null; reason_code: string | null;
};

function mapRun(row: RunRow): RunRecord {
  try {
    requireId(row.run_id); requireId(row.session_id);
    if (row.provider_run_id !== null) requireId(row.provider_run_id);
    requireDigest(row.idempotency_key_hash); requireDigest(row.request_digest); requireTime(row.created_at);
    if (row.started_at !== null) requireTime(row.started_at); if (row.ended_at !== null) requireTime(row.ended_at);
    if (row.operation !== "start_run" || !RUN_STATUSES.includes(row.status as RunStatus) || row.execution_count !== 1 ||
      !Number.isSafeInteger(row.lifecycle_version) || row.lifecycle_version < 1 ||
      (row.reason_code !== null && !/^[a-z][a-z0-9_]{0,63}$/.test(row.reason_code))) throw new Error();
    return {
      runId: row.run_id, sessionId: row.session_id, operation: row.operation, providerRunId: row.provider_run_id,
      idempotencyKeyHash: row.idempotency_key_hash, requestDigest: row.request_digest, status: row.status as RunStatus,
      lifecycleVersion: row.lifecycle_version, executionCount: 1, createdAt: row.created_at, startedAt: row.started_at,
      endedAt: row.ended_at, reasonCode: row.reason_code,
    };
  } catch { throw new SafeError("runtime_database_corrupt"); }
}

type ApprovalRow = {
  approval_id: string; run_id: string; action_type: string; action_digest: string; status: string; version: number;
  created_at: string; expires_at: string; resolved_at: string | null; reason_code: string | null;
};
function mapApproval(row: ApprovalRow): ApprovalRecord {
  try {
    requireId(row.approval_id); requireId(row.run_id); requireDigest(row.action_digest); requireTime(row.created_at); requireTime(row.expires_at);
    if (row.resolved_at !== null) requireTime(row.resolved_at);
    if ((row.action_type !== "command" && row.action_type !== "file_change") || !["pending", "approved", "denied", "expired"].includes(row.status) ||
      !Number.isSafeInteger(row.version) || row.version < 1) throw new Error();
    return { approvalId: row.approval_id, runId: row.run_id, actionType: row.action_type, actionDigest: row.action_digest,
      status: row.status as ApprovalStatus, version: row.version, createdAt: row.created_at, expiresAt: row.expires_at,
      resolvedAt: row.resolved_at, reasonCode: row.reason_code };
  } catch { throw new SafeError("runtime_database_corrupt"); }
}

export class RuntimeStore {
  readonly db: Database;

  constructor(path: string, recoveryTime = new Date().toISOString()) {
    requireTime(recoveryTime);
    const parent = dirname(path);
    assertNoSymlinks(parent);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertNoSymlinks(parent);
    const directory = lstatSync(parent);
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw new SafeError("unsafe_runtime_directory");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) safeFile(path + suffix);
    let created = false;
    try { lstatSync(path); }
    catch (error) {
      if (!isMissing(error)) throw error;
      closeSync(openSync(path, "wx", 0o600));
      created = true;
    }
    this.db = new Database(path, { strict: true });
    try {
      if (created) {
        this.db.transaction(() => {
          this.db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};`);
          for (const sql of SCHEMA) this.db.exec(sql);
        })();
      } else {
        const identity = this.db.query("PRAGMA application_id").get() as { application_id: number };
        const version = this.db.query("PRAGMA user_version").get() as { user_version: number };
        const actual = () => (this.db.query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all() as { sql: string }[])
          .map(row => normalizedSql(row.sql)).sort();
        const matches = (schema: readonly string[]) => JSON.stringify(actual()) === JSON.stringify(schema.map(normalizedSql).sort());
        if (identity.application_id !== APPLICATION_ID) throw new SafeError("foreign_runtime_database_denied");
        if (version.user_version === 1 && matches(SCHEMA_V1)) {
          // Exact v1 schema only: additive, transactional migration.
          this.db.transaction(() => {
            for (const sql of SCHEMA_V2_ADDITIONS) this.db.exec(sql);
            this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION};`);
          })();
        }
        const current = this.db.query("PRAGMA user_version").get() as { user_version: number };
        if (current.user_version !== SCHEMA_VERSION || !matches(SCHEMA)) throw new SafeError("foreign_runtime_database_denied");
      }
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;");
      chmodSync(path, 0o600);
      this.#recoverUncertain(recoveryTime);
    } catch (error) { this.db.close(); throw error; }
  }

  createSession(record: SessionRecord): SessionRecord {
    requireId(record.sessionId); requireId(record.providerSessionId);
    requireTime(record.createdAt); requireTime(record.lastObservedAt);
    if (!validProject(record.target.projectId)) throw new SafeError("invalid_runtime_target");
    const identity = vmIdentity(record.target.vmName);
    if (identity.provider !== record.target.provider || identity.project !== record.target.projectId || !record.target.discoveryVersion) {
      throw new SafeError("invalid_runtime_target");
    }
    this.db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      record.sessionId, record.target.provider, record.target.projectId, record.target.vmName, record.target.vmInstanceId,
      record.target.discoveryVersion, record.providerSessionId, record.createdAt, record.lastObservedAt,
    );
    return record;
  }

  getSession(sessionId: string): SessionRecord | null {
    requireId(sessionId);
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id=?").get(sessionId) as {
      session_id: string; provider: string; project_id: string; vm_name: string; vm_instance_id: string | null;
      discovery_version: string; provider_session_id: string; created_at: string; last_observed_at: string;
    } | null;
    if (!row) return null;
    try {
      const identity = vmIdentity(row.vm_name);
      if (identity.provider !== row.provider || identity.project !== row.project_id || !row.discovery_version ||
        !validProject(row.project_id) || (row.vm_instance_id !== null && !validId(row.vm_instance_id))) throw new Error();
      requireId(row.provider_session_id); requireTime(row.created_at); requireTime(row.last_observed_at);
      return { sessionId: row.session_id, target: { provider: identity.provider, projectId: row.project_id,
        vmName: row.vm_name, vmInstanceId: row.vm_instance_id, discoveryVersion: row.discovery_version },
        providerSessionId: row.provider_session_id, createdAt: row.created_at, lastObservedAt: row.last_observed_at };
    } catch { throw new SafeError("runtime_database_corrupt"); }
  }

  beginRun(input: BeginRunInput): BeginRunResult {
    requireId(input.runId); requireId(input.sessionId); requireTime(input.createdAt); requireDigest(input.requestDigest);
    const operation = input.operation ?? "start_run";
    const hash = keyHash(input.idempotencyKey);
    return this.db.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM runs WHERE session_id=? AND operation=? AND idempotency_key_hash=?").get(input.sessionId, operation, hash) as RunRow | null;
      if (prior) {
        if (prior.request_digest !== input.requestDigest) throw new SafeError("idempotency_key_conflict");
        return { run: mapRun(prior), created: false };
      }
      if (input.exclusiveProject !== undefined && this.activeRunForProject(input.exclusiveProject)) throw new SafeError("project_busy");
      this.db.prepare("INSERT INTO runs VALUES (?, ?, ?, NULL, ?, ?, 'prepared', 1, 1, ?, NULL, NULL, NULL)")
        .run(input.runId, input.sessionId, operation, hash, input.requestDigest, input.createdAt);
      this.#insertJournal({ eventId: `${input.runId}:1`, runId: input.runId, type: "run.prepared", occurredAt: input.createdAt, payload: { status: "prepared" } });
      return { run: this.#requireRun(input.runId), created: true };
    })();
  }

  findRunByKey(sessionId: string, idempotencyKey: string, operation: "start_run" = "start_run"): RunRecord | null {
    requireId(sessionId);
    const row = this.db.prepare("SELECT * FROM runs WHERE session_id=? AND operation=? AND idempotency_key_hash=?").get(sessionId, operation, keyHash(idempotencyKey)) as RunRow | null;
    return row ? mapRun(row) : null;
  }

  getRun(runId: string): RunRecord | null {
    requireId(runId);
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id=?").get(runId) as RunRow | null;
    return row ? mapRun(row) : null;
  }

  transition(runId: string, expectedVersion: number, next: RunStatus, occurredAt: string, options: { providerRunId?: string; reasonCode?: string } = {}): RunRecord {
    requireId(runId); requireTime(occurredAt);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !RUN_STATUSES.includes(next)) throw new SafeError("invalid_run_transition");
    if (options.providerRunId !== undefined) requireId(options.providerRunId);
    if (options.reasonCode !== undefined && !/^[a-z][a-z0-9_]{0,63}$/.test(options.reasonCode)) throw new SafeError("invalid_reason_code");
    return this.db.transaction(() => {
      const current = this.#requireRun(runId);
      if (current.lifecycleVersion !== expectedVersion) throw new SafeError("run_version_conflict");
      if (!this.#transitionAllowed(current.status, next)) throw new SafeError("invalid_run_transition");
      const version = current.lifecycleVersion + 1;
      const startedAt = next === "running" && current.startedAt === null ? occurredAt : current.startedAt;
      const endedAt = ["completed", "failed", "interrupted", "unknown"].includes(next) ? occurredAt : null;
      const providerRunId = options.providerRunId ?? current.providerRunId;
      const update = this.db.prepare("UPDATE runs SET status=?, lifecycle_version=?, provider_run_id=?, started_at=?, ended_at=?, reason_code=? WHERE run_id=? AND lifecycle_version=?")
        .run(next, version, providerRunId, startedAt, endedAt, options.reasonCode ?? null, runId, expectedVersion);
      if (update.changes !== 1) throw new SafeError("run_version_conflict");
      const type: JournalType = next === "dispatching" ? "run.dispatching" : next === "running" ? "run.started" : "run.status_changed";
      const payload = type === "run.started" ? { status: next, providerBound: providerRunId !== null }
        : type === "run.dispatching" ? { status: next }
        : { from: current.status, to: next, ...(options.reasonCode ? { reasonCode: options.reasonCode } : {}) };
      this.#insertJournal({ eventId: `${runId}:${version}`, runId, type, occurredAt, payload });
      return this.#requireRun(runId);
    })();
  }

  appendJournal(input: JournalInput & { type: "operation.notice" }): JournalRecord {
    return this.db.transaction(() => this.#insertJournal(input))();
  }

  replay(afterSequence = 0, limit = 100): JournalRecord[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new SafeError("invalid_journal_cursor");
    }
    const rows = this.db.prepare("SELECT sequence,event_id,run_id,type,occurred_at,payload_json FROM journal WHERE sequence>? ORDER BY sequence LIMIT ?")
      .all(afterSequence, limit) as Array<{ sequence: number; event_id: string; run_id: string | null; type: JournalType; occurred_at: string; payload_json: string }>;
    try {
      return rows.map(row => {
        if (!Number.isSafeInteger(row.sequence) || row.sequence < 1 || !Object.hasOwn(PAYLOAD_FIELDS, row.type)) throw new Error();
        requireId(row.event_id); if (row.run_id !== null) requireId(row.run_id); requireTime(row.occurred_at);
        const payload = JSON.parse(row.payload_json) as unknown;
        if (typeof payload !== "object" || payload === null || Array.isArray(payload) || canonicalPayload(row.type, payload as Record<string, unknown>) !== row.payload_json) throw new Error();
        return { sequence: row.sequence, eventId: row.event_id, runId: row.run_id, type: row.type, occurredAt: row.occurred_at, payload: payload as Record<string, unknown> };
      });
    } catch { throw new SafeError("runtime_database_corrupt"); }
  }

  findSession(target: ExecutionTarget, providerSessionId: string): SessionRecord | null {
    requireId(providerSessionId);
    const row = this.db.prepare("SELECT session_id FROM sessions WHERE provider=? AND project_id=? AND vm_name=? AND provider_session_id=?")
      .get(target.provider, target.projectId, target.vmName, providerSessionId) as { session_id: string } | null;
    return row ? this.getSession(row.session_id) : null;
  }

  listSessions(projects: readonly string[]): SessionRecord[] {
    if (projects.length === 0) return [];
    const marks = projects.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT session_id FROM sessions WHERE project_id IN (${marks}) ORDER BY last_observed_at DESC LIMIT 500`)
      .all(...projects) as { session_id: string }[];
    return rows.map(row => this.getSession(row.session_id)!).filter(Boolean);
  }

  touchSession(sessionId: string, at: string): void {
    requireId(sessionId); requireTime(at);
    this.db.prepare("UPDATE sessions SET last_observed_at=? WHERE session_id=? AND last_observed_at<?").run(at, sessionId, at);
  }

  listRuns(sessionId: string, limit = 50): RunRecord[] {
    requireId(sessionId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new SafeError("invalid_limit");
    return (this.db.prepare("SELECT * FROM runs WHERE session_id=? ORDER BY created_at DESC, run_id DESC LIMIT ?").all(sessionId, limit) as RunRow[]).map(mapRun);
  }

  runsWithStatus(statuses: readonly RunStatus[]): RunRecord[] {
    if (statuses.length === 0 || statuses.some(status => !RUN_STATUSES.includes(status))) throw new SafeError("invalid_run_status");
    const marks = statuses.map(() => "?").join(",");
    return (this.db.prepare(`SELECT * FROM runs WHERE status IN (${marks}) ORDER BY created_at`).all(...statuses) as RunRow[]).map(mapRun);
  }

  activeRunForProject(projectId: string): RunRecord | null {
    if (!validProject(projectId)) throw new SafeError("invalid_runtime_target");
    const marks = ACTIVE_RUN_STATUSES.map(() => "?").join(",");
    const row = this.db.prepare(`SELECT r.* FROM runs r JOIN sessions s ON s.session_id=r.session_id WHERE s.project_id=? AND r.status IN (${marks}) ORDER BY r.created_at LIMIT 1`)
      .get(projectId, ...ACTIVE_RUN_STATUSES) as RunRow | null;
    return row ? mapRun(row) : null;
  }

  createApproval(record: Omit<ApprovalRecord, "status" | "version" | "resolvedAt" | "reasonCode">): ApprovalRecord {
    requireId(record.approvalId); requireId(record.runId); requireDigest(record.actionDigest);
    requireTime(record.createdAt); requireTime(record.expiresAt);
    if (record.actionType !== "command" && record.actionType !== "file_change") throw new SafeError("invalid_approval");
    return this.db.transaction(() => {
      this.db.prepare("INSERT INTO approvals VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, NULL, NULL)")
        .run(record.approvalId, record.runId, record.actionType, record.actionDigest, record.createdAt, record.expiresAt);
      this.#insertJournal({ eventId: `${record.approvalId}:1`, runId: record.runId, type: "approval.requested", occurredAt: record.createdAt,
        payload: { approvalId: record.approvalId, actionType: record.actionType, status: "pending" } });
      return this.getApproval(record.approvalId)!;
    })();
  }

  getApproval(approvalId: string): ApprovalRecord | null {
    requireId(approvalId);
    const row = this.db.prepare("SELECT * FROM approvals WHERE approval_id=?").get(approvalId) as ApprovalRow | null;
    return row ? mapApproval(row) : null;
  }

  pendingApprovals(): ApprovalRecord[] {
    return (this.db.query("SELECT * FROM approvals WHERE status='pending' ORDER BY created_at").all() as ApprovalRow[]).map(mapApproval);
  }

  /** Compare-and-set of a human decision. Identical replay is a no-op; anything else conflicts. */
  resolveApproval(approvalId: string, expectedVersion: number, status: "approved" | "denied", at: string): { approval: ApprovalRecord; changed: boolean } {
    requireId(approvalId); requireTime(at);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new SafeError("approval_conflict");
    return this.db.transaction(() => {
      const current = this.getApproval(approvalId);
      if (!current) throw new SafeError("resource_not_found");
      if (current.status === status && current.version === expectedVersion + 1) return { approval: current, changed: false };
      if (current.status !== "pending" || current.version !== expectedVersion) throw new SafeError("approval_conflict");
      if (Date.parse(current.expiresAt) <= Date.parse(at)) throw new SafeError("approval_expired");
      this.db.prepare("UPDATE approvals SET status=?, version=version+1, resolved_at=?, reason_code='human_decision' WHERE approval_id=? AND version=?")
        .run(status, at, approvalId, expectedVersion);
      this.#insertJournal({ eventId: `${approvalId}:${expectedVersion + 1}`, runId: current.runId, type: "approval.resolved", occurredAt: at,
        payload: { approvalId, status, reasonCode: "human_decision" } });
      return { approval: this.getApproval(approvalId)!, changed: true };
    })();
  }

  expireApprovals(runId: string, reasonCode: string, at: string): number {
    requireId(runId); requireTime(at);
    return this.db.transaction(() => this.#expirePendingApprovals("SELECT approval_id FROM approvals WHERE status='pending' AND run_id=? ORDER BY approval_id", [runId], reasonCode, at))();
  }

  expireApproval(approvalId: string, reasonCode: string, at: string): number {
    requireId(approvalId); requireTime(at);
    return this.db.transaction(() => this.#expirePendingApprovals("SELECT approval_id FROM approvals WHERE status='pending' AND approval_id=?", [approvalId], reasonCode, at))();
  }

  recordUsage(runId: string, usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }, at: string): void {
    requireId(runId); requireTime(at);
    const count = (value: number | undefined) => value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
    this.db.prepare("INSERT INTO run_metrics VALUES (?, ?, ?, ?, 'session_cumulative', ?) ON CONFLICT(run_id) DO UPDATE SET input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens, cached_input_tokens=excluded.cached_input_tokens, token_scope=excluded.token_scope, updated_at=excluded.updated_at")
      .run(runId, count(usage.inputTokens), count(usage.outputTokens), count(usage.cachedInputTokens), at);
  }

  metrics(run: RunRecord): RunMetrics {
    const row = this.db.prepare("SELECT input_tokens, output_tokens, cached_input_tokens, token_scope FROM run_metrics WHERE run_id=?").get(run.runId) as
      { input_tokens: number | null; output_tokens: number | null; cached_input_tokens: number | null; token_scope: "not_measured" | "session_cumulative" } | null;
    const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
    const ended = run.endedAt ? Date.parse(run.endedAt) : NaN;
    const terminal = run.status === "completed" || run.status === "failed" || run.status === "interrupted";
    const durationMs = terminal && Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null;
    return {
      inputTokens: row?.input_tokens ?? null, outputTokens: row?.output_tokens ?? null, cachedInputTokens: row?.cached_input_tokens ?? null,
      tokenScope: row?.token_scope ?? "not_measured", durationMs, durationSource: durationMs === null ? "not_measured" : "host_clock",
    };
  }

  /** Journal tail restricted to runs of the given projects; run-less notices are never exposed. */
  replayForProjects(projects: readonly string[], afterSequence = 0, limit = 200): ProjectJournalRecord[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new SafeError("invalid_journal_cursor");
    }
    if (projects.length === 0) return [];
    const marks = projects.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT j.sequence, j.event_id, j.run_id, j.type, j.occurred_at, j.payload_json, s.session_id, s.project_id FROM journal j JOIN runs r ON r.run_id=j.run_id JOIN sessions s ON s.session_id=r.session_id WHERE j.sequence>? AND s.project_id IN (${marks}) ORDER BY j.sequence LIMIT ?`)
      .all(afterSequence, ...projects, limit) as Array<{ sequence: number; event_id: string; run_id: string; type: JournalType; occurred_at: string; payload_json: string; session_id: string; project_id: string }>;
    try {
      return rows.map(row => {
        if (!Object.hasOwn(PAYLOAD_FIELDS, row.type)) throw new Error();
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        if (canonicalPayload(row.type, payload) !== row.payload_json) throw new Error();
        return { sequence: row.sequence, eventId: row.event_id, runId: row.run_id, type: row.type, occurredAt: row.occurred_at, payload,
          sessionId: row.session_id, projectId: row.project_id };
      });
    } catch { throw new SafeError("runtime_database_corrupt"); }
  }

  lastSequence(): number {
    return (this.db.query("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM journal").get() as { sequence: number }).sequence;
  }

  #expirePendingApprovals(select: string, params: string[], reasonCode: string, at: string): number {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(reasonCode)) throw new SafeError("invalid_reason_code");
    const rows = this.db.prepare(select).all(...params) as { approval_id: string }[];
    for (const { approval_id } of rows) {
      const current = this.getApproval(approval_id)!;
      this.db.prepare("UPDATE approvals SET status='expired', version=version+1, resolved_at=?, reason_code=? WHERE approval_id=? AND status='pending'")
        .run(at, reasonCode, approval_id);
      this.#insertJournal({ eventId: `${approval_id}:${current.version + 1}`, runId: current.runId, type: "approval.resolved", occurredAt: at,
        payload: { approvalId: approval_id, status: "expired", reasonCode } });
    }
    return rows.length;
  }

  close(): void { this.db.close(); }

  #requireRun(runId: string): RunRecord {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id=?").get(runId) as RunRow | null;
    if (!row) throw new SafeError("run_not_found");
    return mapRun(row);
  }

  #transitionAllowed(from: RunStatus, to: RunStatus): boolean {
    const allowed: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
      prepared: ["dispatching", "failed"],
      dispatching: ["running", "unknown", "failed"],
      running: ["awaiting_approval", "completed", "failed", "interrupted", "unknown"],
      awaiting_approval: ["running", "completed", "failed", "interrupted", "unknown"],
      unknown: ["running", "completed", "failed", "interrupted"],
      completed: [], failed: [], interrupted: [],
    };
    return allowed[from].includes(to);
  }

  #insertJournal(input: JournalInput): JournalRecord {
    requireId(input.eventId); if (input.runId !== null) requireId(input.runId); requireTime(input.occurredAt);
    if (!Object.hasOwn(PAYLOAD_FIELDS, input.type)) throw new SafeError("journal_type_denied");
    const payloadJson = canonicalPayload(input.type, input.payload);
    const next = (this.db.query("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM journal").get() as { sequence: number }).sequence;
    this.db.prepare("INSERT INTO journal VALUES (?, ?, ?, ?, ?, ?)").run(next, input.eventId, input.runId, input.type, input.occurredAt, payloadJson);
    return { ...input, sequence: next, payload: JSON.parse(payloadJson) as Record<string, unknown> };
  }

  #recoverUncertain(occurredAt: string): void {
    this.db.transaction(() => {
      const rows = this.db.query("SELECT * FROM runs WHERE status IN ('dispatching','running','awaiting_approval') ORDER BY run_id").all() as RunRow[];
      for (const row of rows) {
        const version = row.lifecycle_version + 1;
        this.db.prepare("UPDATE runs SET status='unknown', lifecycle_version=?, ended_at=?, reason_code='process_restarted' WHERE run_id=?")
          .run(version, occurredAt, row.run_id);
        this.#insertJournal({
          eventId: `${row.run_id}:${version}`,
          runId: row.run_id,
          type: "run.recovery_unknown",
          occurredAt,
          payload: { from: row.status, to: "unknown", reasonCode: "process_restarted" },
        });
      }
      // Approval handles live in the provider connection; a restart can never revive them.
      this.#expirePendingApprovals("SELECT approval_id FROM approvals WHERE status='pending' ORDER BY approval_id", [], "process_restarted", occurredAt);
    })();
  }
}

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SafeError, type Snapshot, type Vm } from "./model.ts";
import type { RuntimeStore, RunRecord, SessionRecord } from "./runtime-store.ts";
import { ProjectGrants } from "./project-grants.ts";

/**
 * F1 sliding session: a session ends after IDLE_MS without OPERATOR activity, and at most SESSION_MAX_MS after login,
 * whichever comes first. Activity is never inferred from traffic (polling, SSE, heartbeats): only a CSRF-verified mutation or an
 * explicit activity signal sent by the page after real input (`touch`) moves the idle deadline. The absolute ceiling never moves.
 */
export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_MAX_MS = 12 * 60 * 60_000;
const MAX_SESSIONS = 32;
/**
 * Replay protection without a capacity dead end (F1-A). Nonces are remembered per CSRF *epoch*. When an epoch holds
 * MAX_NONCES_PER_EPOCH nonces it is closed: the session gets a fresh CSRF token and an empty set. Every request of a closed
 * epoch still carries the old token and is refused (`csrf_denied`), so a captured request can never be replayed, memory stays
 * bounded (one set per session), and no mutation — interrupt included — is ever refused for capacity. The page re-reads the
 * token once on `csrf_denied` (nothing was executed: CSRF is checked before any effect) and resends with a new nonce.
 */
export const MAX_NONCES_PER_EPOCH = 1024;
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES = 5;
const tokenPattern = /^[a-f0-9]{64}$/;
const noncePattern = /^[A-Za-z0-9_-]{22,128}$/;
const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
const equal = (a: Buffer, b: Buffer): boolean => timingSafeEqual(a, b);
const random = (): string => randomBytes(32).toString("base64url");

interface LocalSession {
  id: string;
  proof: string;
  csrf: string;
  /** Closed CSRF epochs so far (diagnostics/tests only). */
  epoch: number;
  createdAt: number;
  lastActivityAt: number;
  nonces: Set<string>;
}

export interface LocalPrincipal { readonly grants: ReadonlySet<string>; readonly session: LocalSession }

export class LocalSecurity {
  readonly #credentialDigest: Buffer;
  readonly #grants: ProjectGrants;
  readonly #sessions = new Map<string, LocalSession>();
  readonly #failures: number[] = [];
  readonly #now: () => number;
  readonly #idleMs: number;
  readonly #maxMs: number;
  readonly #maxNonces: number;

  /**
   * `projects`: a fixed, non-empty list (configuration only, legacy) or a ProjectGrants (configuration ∪ UI grants, may start
   * empty). Either way every principal reads the same live grant set: a revocation applies to the next check of every session.
   */
  constructor(credential: string, projects: readonly string[] | ProjectGrants, now: () => number = Date.now,
    limits: { idleMs?: number; maxMs?: number; maxNoncesPerEpoch?: number } = {}) {
    if (!tokenPattern.test(credential)) throw new SafeError("local_credential_required");
    this.#grants = projects instanceof ProjectGrants ? projects : ProjectGrants.fixed(projects);
    this.#credentialDigest = digest(credential);
    this.#now = now;
    this.#idleMs = limits.idleMs ?? SESSION_IDLE_MS;
    this.#maxMs = limits.maxMs ?? SESSION_MAX_MS;
    this.#maxNonces = limits.maxNoncesPerEpoch ?? MAX_NONCES_PER_EPOCH;
    if (!(this.#idleMs > 0 && this.#maxMs >= this.#idleMs) || !Number.isSafeInteger(this.#maxNonces) || this.#maxNonces < 1 || this.#maxNonces > 65_536) {
      throw new SafeError("invalid_session_limits");
    }
  }

  /** The startup check of the local credential (64 lowercase hex), without building anything. */
  static assertCredential(credential: string): void { if (!tokenPattern.test(credential)) throw new SafeError("local_credential_required"); }

  /** Cookie lifetime: the absolute ceiling (the server enforces the idle deadline itself). */
  get cookieMaxAgeSeconds(): number { return Math.floor(this.#maxMs / 1000); }

  #expiresAt(session: LocalSession): number {
    return Math.min(session.lastActivityAt + this.#idleMs, session.createdAt + this.#maxMs);
  }

  login(credential: unknown, prior?: LocalPrincipal): { cookie: string; proof: string; csrf: string } {
    const now = this.#now();
    while (this.#failures[0] !== undefined && this.#failures[0] <= now - FAILURE_WINDOW_MS) this.#failures.shift();
    const candidate = typeof credential === "string" && credential.length <= 512 ? digest(credential) : digest("");
    if (!equal(candidate, this.#credentialDigest)) {
      if (this.#failures.length >= MAX_FAILURES) throw new SafeError("auth_rate_limited");
      this.#failures.push(now);
      throw new SafeError("authentication_failed");
    }
    this.#prune(now);
    if (prior) this.#sessions.delete(prior.session.id);
    if (this.#sessions.size >= MAX_SESSIONS) this.#sessions.delete(this.#sessions.keys().next().value!);
    // Always a fresh identifier (no fixation): a cookie value is only ever accepted if this server minted it at login.
    const session: LocalSession = { id: random(), proof: random(), csrf: random(), epoch: 0, createdAt: now, lastActivityAt: now, nonces: new Set() };
    this.#sessions.set(session.id, session);
    return { cookie: session.id, proof: session.proof, csrf: session.csrf };
  }

  authenticate(cookieHeader: string | null, proofHeader: string | null): LocalPrincipal {
    const cookies = (cookieHeader ?? "").split(";").map(item => item.trim()).filter(item => item.startsWith("cockpit_session="));
    if (cookies.length !== 1) throw new SafeError("authentication_required");
    const value = cookies[0]!.slice("cockpit_session=".length);
    if (!noncePattern.test(value)) throw new SafeError("authentication_required");
    const session = this.#sessions.get(value);
    if (!session || this.#expiresAt(session) <= this.#now()) {
      this.#sessions.delete(value);
      throw new SafeError("authentication_required");
    }
    if (!proofHeader || !noncePattern.test(proofHeader) || !equal(digest(proofHeader), digest(session.proof))) {
      throw new SafeError("authentication_required");
    }
    return { grants: this.#grants.view, session };
  }

  csrf(principal: LocalPrincipal, token: string | null, nonce: string | null): void {
    if (!token || token.length > 128 || !nonce || !noncePattern.test(nonce) || !equal(digest(token), digest(principal.session.csrf))) throw new SafeError("csrf_denied");
    // A session revoked or expired since `authenticate` accepts nothing (and its epoch can no longer move).
    if (!this.isActive(principal)) throw new SafeError("authentication_required");
    const session = principal.session;
    if (session.nonces.has(nonce)) throw new SafeError("replay_denied");
    session.nonces.add(nonce);
    // Epoch full: close it AFTER accepting this request. Its token dies with it, so none of its requests can come back.
    if (session.nonces.size >= this.#maxNonces) { session.csrf = random(); session.nonces = new Set(); session.epoch++; }
    // A CSRF-verified mutation is operator activity by construction (only the page's own script can send it).
    this.touch(principal);
  }

  /**
   * Moves the idle deadline to now + IDLE (never past the absolute ceiling). Only for an authenticated, still-active session;
   * callers decide what counts as activity — never polling, SSE or heartbeats.
   */
  touch(principal: LocalPrincipal): void {
    if (!this.isActive(principal)) return;
    principal.session.lastActivityAt = this.#now();
  }

  /** The grant authority shared by every principal (configuration ∪ UI grants). */
  get grants(): ProjectGrants { return this.#grants; }

  /** Opaque, stable reference to a session for audit records: never the cookie, proof or CSRF value itself. */
  auditActor(principal: LocalPrincipal): string {
    return `local_operator:${createHash("sha256").update(`cockpit-audit:${principal.session.id}`, "utf8").digest("hex").slice(0, 16)}`;
  }

  logout(principal: LocalPrincipal): void { this.#sessions.delete(principal.session.id); }
  sessionInfo(principal: LocalPrincipal): { csrf: string; expires_at: string; absolute_expires_at: string; idle_timeout_seconds: number } {
    const session = principal.session;
    return { csrf: session.csrf, expires_at: new Date(this.#expiresAt(session)).toISOString(),
      absolute_expires_at: new Date(session.createdAt + this.#maxMs).toISOString(), idle_timeout_seconds: Math.floor(this.#idleMs / 1000) };
  }
  /**
   * The one per-project gate of every route (inventory, VM, session, run, history, approval). Defense in depth (P-D4): a reserved
   * project is refused here even if a grant set were ever to contain it.
   */
  allows(principal: LocalPrincipal, project: string): boolean {
    return principal.grants.has(project) && !this.#grants.reserved(project);
  }
  authorizeProject(principal: LocalPrincipal, project: string): void {
    if (!this.allows(principal, project)) throw new SafeError("resource_not_found");
  }
  visible(snapshot: Snapshot, principal: LocalPrincipal): Snapshot {
    return { ...snapshot, projects: snapshot.projects.filter(project => this.allows(principal, project)),
      vms: snapshot.vms.filter(vm => this.allows(principal, vm.project)) };
  }
  authorizeVm(snapshot: Snapshot, principal: LocalPrincipal, vmName: string): Vm {
    const vm = snapshot.vms.find(item => item.vm_name === vmName);
    if (!vm || !this.allows(principal, vm.project) || !snapshot.projects.includes(vm.project) || vm.orphaned || vm.state !== "running") {
      throw new SafeError("resource_not_found");
    }
    return vm;
  }
  authorizeRun(store: Pick<RuntimeStore, "getRun" | "getSession">, principal: LocalPrincipal, runId: string): { run: RunRecord; session: SessionRecord } {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) throw new SafeError("resource_not_found");
    const run = store.getRun(runId);
    const session = run ? store.getSession(run.sessionId) : null;
    if (!run || !session || !this.allows(principal, session.target.projectId)) throw new SafeError("resource_not_found");
    return { run, session };
  }
  authorizeSession(store: Pick<RuntimeStore, "getSession">, principal: LocalPrincipal, sessionId: string): SessionRecord {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)) throw new SafeError("resource_not_found");
    const session = store.getSession(sessionId);
    if (!session || !this.allows(principal, session.target.projectId)) throw new SafeError("resource_not_found");
    return session;
  }
  /** Long-lived streams re-check this so logout or expiry ends them. */
  isActive(principal: LocalPrincipal): boolean {
    return this.#sessions.get(principal.session.id) === principal.session && this.#expiresAt(principal.session) > this.#now();
  }
  #prune(now: number): void {
    for (const [id, session] of this.#sessions) if (this.#expiresAt(session) <= now) this.#sessions.delete(id);
  }
}

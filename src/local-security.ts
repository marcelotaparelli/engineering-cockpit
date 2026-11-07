import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SafeError, validProject, type Snapshot, type Vm } from "./model.ts";
import type { RuntimeStore, RunRecord, SessionRecord } from "./runtime-store.ts";

const SESSION_MS = 30 * 60_000;
const MAX_SESSIONS = 32;
const MAX_NONCES = 256;
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
  expiresAt: number;
  nonces: Set<string>;
}

export interface LocalPrincipal { readonly grants: ReadonlySet<string>; readonly session: LocalSession }

export class LocalSecurity {
  readonly #credentialDigest: Buffer;
  readonly #grants: ReadonlySet<string>;
  readonly #sessions = new Map<string, LocalSession>();
  readonly #failures: number[] = [];
  readonly #now: () => number;

  constructor(credential: string, projects: readonly string[], now: () => number = Date.now) {
    if (!tokenPattern.test(credential)) throw new SafeError("local_credential_required");
    if (projects.length === 0 || projects.some(project => !validProject(project)) || new Set(projects).size !== projects.length) {
      throw new SafeError("local_grants_required");
    }
    this.#credentialDigest = digest(credential);
    this.#grants = new Set(projects);
    this.#now = now;
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
    const session: LocalSession = { id: random(), proof: random(), csrf: random(), expiresAt: now + SESSION_MS, nonces: new Set() };
    this.#sessions.set(session.id, session);
    return { cookie: session.id, proof: session.proof, csrf: session.csrf };
  }

  authenticate(cookieHeader: string | null, proofHeader: string | null): LocalPrincipal {
    const cookies = (cookieHeader ?? "").split(";").map(item => item.trim()).filter(item => item.startsWith("cockpit_session="));
    if (cookies.length !== 1) throw new SafeError("authentication_required");
    const value = cookies[0]!.slice("cockpit_session=".length);
    if (!noncePattern.test(value)) throw new SafeError("authentication_required");
    const session = this.#sessions.get(value);
    if (!session || session.expiresAt <= this.#now()) {
      this.#sessions.delete(value);
      throw new SafeError("authentication_required");
    }
    if (!proofHeader || !noncePattern.test(proofHeader) || !equal(digest(proofHeader), digest(session.proof))) {
      throw new SafeError("authentication_required");
    }
    return { grants: this.#grants, session };
  }

  csrf(principal: LocalPrincipal, token: string | null, nonce: string | null): void {
    if (!token || token.length > 128 || !nonce || !noncePattern.test(nonce) || !equal(digest(token), digest(principal.session.csrf))) throw new SafeError("csrf_denied");
    if (principal.session.nonces.has(nonce)) throw new SafeError("replay_denied");
    if (principal.session.nonces.size >= MAX_NONCES) throw new SafeError("nonce_capacity_reached");
    principal.session.nonces.add(nonce);
  }

  logout(principal: LocalPrincipal): void { this.#sessions.delete(principal.session.id); }
  sessionInfo(principal: LocalPrincipal): { csrf: string; expires_at: string } {
    return { csrf: principal.session.csrf, expires_at: new Date(principal.session.expiresAt).toISOString() };
  }
  authorizeProject(principal: LocalPrincipal, project: string): void {
    if (!principal.grants.has(project)) throw new SafeError("resource_not_found");
  }
  visible(snapshot: Snapshot, principal: LocalPrincipal): Snapshot {
    return { ...snapshot, projects: snapshot.projects.filter(project => principal.grants.has(project)),
      vms: snapshot.vms.filter(vm => principal.grants.has(vm.project)) };
  }
  authorizeVm(snapshot: Snapshot, principal: LocalPrincipal, vmName: string): Vm {
    const vm = snapshot.vms.find(item => item.vm_name === vmName);
    if (!vm || !principal.grants.has(vm.project) || !snapshot.projects.includes(vm.project) || vm.orphaned || vm.state !== "running") {
      throw new SafeError("resource_not_found");
    }
    return vm;
  }
  authorizeRun(store: Pick<RuntimeStore, "getRun" | "getSession">, principal: LocalPrincipal, runId: string): { run: RunRecord; session: SessionRecord } {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) throw new SafeError("resource_not_found");
    const run = store.getRun(runId);
    const session = run ? store.getSession(run.sessionId) : null;
    if (!run || !session || !principal.grants.has(session.target.projectId)) throw new SafeError("resource_not_found");
    return { run, session };
  }
  #prune(now: number): void {
    for (const [id, session] of this.#sessions) if (session.expiresAt <= now) this.#sessions.delete(id);
  }
}

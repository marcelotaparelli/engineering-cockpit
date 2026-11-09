import { SafeError, validProject } from "./model.ts";
import type { GrantAudit, GrantStore } from "./grant-store.ts";
import { DEFAULT_RESERVED_PROJECTS, reservedProjects } from "./reservations.ts";

export { DEFAULT_RESERVED_PROJECTS, reservedProjects };
export type GrantSource = "config" | "ui";
/** Audit actor of changes the Cockpit makes by itself at startup (never an operator session). */
export const SYSTEM_ACTOR = "system:0000000000000000";

/**
 * The single authority on which projects the local operator may see and operate.
 *
 * Effective grants = (configuration ∪ grants made from the authenticated UI) \ reserved projects (P-D4: a reservation wins
 * over every grant, the configuration included). Discovery never grants anything. `view` is ONE live set mutated in place, so every principal, request and stream sees a
 * revocation at its next check (no stale per-session copy).
 */
export class ProjectGrants {
  readonly #config: ReadonlySet<string>;
  readonly #reserved: ReadonlySet<string>;
  readonly #store: GrantStore | null;
  readonly #ui = new Map<string, string>(); // project -> granted_at
  readonly #view = new Set<string>();
  /** UI grants removed at startup because the project is now reserved or in the configuration (for the startup log). */
  readonly shadowedAtStart: readonly string[];
  /** Configuration grants without effect because the project is reserved (for the startup log and the picker). */
  readonly ignoredConfig: readonly string[];

  private constructor(config: readonly string[], reserved: readonly string[], store: GrantStore | null) {
    ProjectGrants.validateConfig(config, reserved);
    this.#config = new Set(config);
    this.#reserved = new Set(reserved);
    this.#store = store;
    // A stored UI grant of a project that became reserved (or that the configuration now grants) is REMOVED, with an audit row:
    // kept dormant, it would come back unseen (and unrevocable from the UI) when the configuration changed again.
    this.shadowedAtStart = store?.dropShadowed(project => this.#reserved.has(project) || this.#config.has(project),
      { actor: SYSTEM_ACTOR, requestId: "startup-reconcile", at: new Date().toISOString() }) ?? [];
    for (const row of store?.list() ?? []) this.#ui.set(row.project, row.grantedAt);
    this.ignoredConfig = [...this.#config].filter(project => this.#reserved.has(project)).sort();
    this.#rebuild();
  }

  /** Configuration-only grants (legacy behaviour): must be non-empty, nothing can be granted at run time. */
  static fixed(projects: readonly string[], reserved: readonly string[] = DEFAULT_RESERVED_PROJECTS): ProjectGrants {
    if (projects.length === 0) throw new SafeError("local_grants_required");
    return new ProjectGrants(projects, reserved, null);
  }

  /** The checks of `managed` that need no store: valid, unique configuration grants and valid reserved names. */
  static validateConfig(config: readonly string[], reserved: readonly string[]): void {
    if (config.some(project => !validProject(project)) || new Set(config).size !== config.length) throw new SafeError("local_grants_required");
    if (reserved.some(project => !validProject(project))) throw new SafeError("invalid_reserved_projects");
  }

  /** Configuration (may be empty) plus UI grants persisted in `store`. */
  static managed(options: { config: readonly string[]; reserved: readonly string[]; store: GrantStore }): ProjectGrants {
    return new ProjectGrants(options.config, options.reserved, options.store);
  }

  get view(): ReadonlySet<string> { return this.#view; }
  get mutable(): boolean { return this.#store !== null; }
  /** Where an EFFECTIVE grant comes from; null for a reserved project whatever is configured or stored. */
  source(project: string): GrantSource | null {
    if (this.#reserved.has(project)) return null;
    return this.#config.has(project) ? "config" : this.#ui.has(project) ? "ui" : null;
  }
  /** Listed in COCKPIT_ALLOWED_PROJECTS but reserved: the configuration grant has no effect. */
  configIgnored(project: string): boolean { return this.#config.has(project) && this.#reserved.has(project); }
  grantedAt(project: string): string | null { return this.#ui.get(project) ?? null; }
  reserved(project: string): boolean { return this.#reserved.has(project); }

  /** Caller has checked that the project is currently discovered. Returns false when it was already granted. */
  grant(project: string, audit: GrantAudit): boolean {
    if (!this.#store) throw new SafeError("grants_read_only");
    if (!validProject(project)) throw new SafeError("resource_not_found");
    if (this.#reserved.has(project)) throw new SafeError("project_reserved");
    if (this.#config.has(project)) return false;
    const changed = this.#store.grant(project, audit);
    this.#ui.set(project, this.#ui.get(project) ?? audit.at);
    this.#rebuild();
    return changed;
  }

  /** Only UI grants can be revoked here; configuration grants are changed in the configuration. */
  revoke(project: string, audit: GrantAudit): boolean {
    if (!this.#store) throw new SafeError("grants_read_only");
    if (this.#reserved.has(project)) throw new SafeError("resource_not_found"); // nothing effective to revoke
    if (this.#config.has(project)) throw new SafeError("grant_from_config");
    if (!this.#ui.has(project)) throw new SafeError("resource_not_found");
    // Durable first (one transaction with its audit row), then memory: a failed write changes nothing and is reported.
    const changed = this.#store.revoke(project, audit);
    this.#ui.delete(project);
    this.#rebuild();
    return changed;
  }

  #rebuild(): void {
    this.#view.clear();
    for (const project of [...this.#config, ...this.#ui.keys()].sort()) if (!this.#reserved.has(project)) this.#view.add(project);
  }
}

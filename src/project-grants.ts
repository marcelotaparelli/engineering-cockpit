import { SafeError, validProject } from "./model.ts";
import type { GrantAudit, GrantStore } from "./grant-store.ts";
import { DEFAULT_RESERVED_VMS } from "./claude-protocol.ts";
import { vmIdentity } from "./model.ts";

export type GrantSource = "config" | "ui";

/**
 * Projects the UI can never authorize: the project of every default-reserved VM (the Cockpit's own development project, D8)
 * plus `COCKPIT_RESERVED_PROJECTS`. The configuration (`COCKPIT_ALLOWED_PROJECTS`) keeps working as before for them.
 */
export const DEFAULT_RESERVED_PROJECTS: readonly string[] = Object.freeze([...new Set(DEFAULT_RESERVED_VMS.map(name => vmIdentity(name).project))]);

export function reservedProjects(value: string | undefined): string[] {
  const names = (value ?? "").split(",").filter(name => name !== "");
  if (new Set(names).size !== names.length || names.some(name => !validProject(name))) throw new SafeError("invalid_reserved_projects");
  return [...new Set([...DEFAULT_RESERVED_PROJECTS, ...names])];
}

/**
 * The single authority on which projects the local operator may see and operate.
 *
 * Effective grants = configuration (fixed at start) ∪ grants made from the authenticated UI (persisted in a GrantStore).
 * Discovery never grants anything. `view` is ONE live set mutated in place, so every principal, request and stream sees a
 * revocation at its next check (no stale per-session copy).
 */
export class ProjectGrants {
  readonly #config: ReadonlySet<string>;
  readonly #reserved: ReadonlySet<string>;
  readonly #store: GrantStore | null;
  readonly #ui = new Map<string, string>(); // project -> granted_at
  readonly #view = new Set<string>();

  private constructor(config: readonly string[], reserved: readonly string[], store: GrantStore | null) {
    ProjectGrants.validateConfig(config, reserved);
    this.#config = new Set(config);
    this.#reserved = new Set(reserved);
    this.#store = store;
    // A UI grant of a project that became reserved (or that the configuration now grants) is not effective as a UI grant.
    for (const row of store?.list() ?? []) if (!this.#reserved.has(row.project) && !this.#config.has(row.project)) this.#ui.set(row.project, row.grantedAt);
    this.#rebuild();
  }

  /** Configuration-only grants (legacy behaviour): must be non-empty, nothing can be granted at run time. */
  static fixed(projects: readonly string[]): ProjectGrants {
    if (projects.length === 0) throw new SafeError("local_grants_required");
    return new ProjectGrants(projects, DEFAULT_RESERVED_PROJECTS, null);
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
  source(project: string): GrantSource | null { return this.#config.has(project) ? "config" : this.#ui.has(project) ? "ui" : null; }
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
    for (const project of [...this.#config, ...this.#ui.keys()].sort()) this.#view.add(project);
  }
}

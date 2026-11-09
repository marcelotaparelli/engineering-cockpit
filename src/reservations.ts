import { DEFAULT_RESERVED_VMS } from "./claude-protocol.ts";
import { SafeError, validProject, vmIdentity, type Provider } from "./model.ts";

/**
 * Reservations (D8, P-D4). A reserved VM reserves its WHOLE project, for every provider: the project is derived from the VM
 * name through the same validated `<provider>-<project>` association discovery uses (`vmIdentity`), never from anything the
 * client sends. A reserved project is never authorized (configuration or UI), never executed, and its history is never served.
 *
 * Sources, all additive (none can lift the development reservation):
 *  - `DEFAULT_RESERVED_VMS` (the development VM, always) and `COCKPIT_RESERVED_VMS`;
 *  - `COCKPIT_RESERVED_PROJECTS`;
 *  - the projects of all the reserved VMs above.
 * The effective VM list is then every provider's VM of every reserved project, plus the explicit VM names.
 */
export const PROVIDERS: readonly Provider[] = Object.freeze(["codex", "claude", "opencode"]);

/** `COCKPIT_RESERVED_VMS`: validated agent VM names on top of the development VM (D8). Unchanged contract since F1. */
export function reservedVms(value: string | undefined): string[] {
  const names = (value ?? "").split(",").filter(name => name !== "");
  if (new Set(names).size !== names.length) throw new SafeError("invalid_reserved_vms");
  for (const name of names) { try { vmIdentity(name); } catch { throw new SafeError("invalid_reserved_vms"); } }
  return [...new Set([...DEFAULT_RESERVED_VMS, ...names])];
}

/** The project of a VM name through the validated association, or null when the name is not an agent VM. */
export function projectOfVm(vmName: string): string | null {
  try { return vmIdentity(vmName).project; } catch { return null; }
}

/** Projects reserved by default: the projects of the default-reserved VMs (`engineering-cockpit`). */
export const DEFAULT_RESERVED_PROJECTS: readonly string[] = Object.freeze([...new Set(DEFAULT_RESERVED_VMS.map(name => vmIdentity(name).project))]);

/** `COCKPIT_RESERVED_PROJECTS` alone (plus the default ones). Does not include projects derived from VMs: see `reservations`. */
export function reservedProjects(value: string | undefined): string[] {
  const names = (value ?? "").split(",").filter(name => name !== "");
  if (new Set(names).size !== names.length || names.some(name => !validProject(name))) throw new SafeError("invalid_reserved_projects");
  return [...new Set([...DEFAULT_RESERVED_PROJECTS, ...names])];
}

export interface Reservations {
  /** Every reserved project: defaults ∪ COCKPIT_RESERVED_PROJECTS ∪ projects of every reserved VM. Sorted. */
  projects: string[];
  /** Explicit reserved VMs ∪ every provider's VM of every reserved project. Sorted. */
  vms: string[];
}

export function reservations(vmsValue: string | undefined, projectsValue: string | undefined): Reservations {
  const explicitVms = reservedVms(vmsValue);
  const projects = [...new Set([...reservedProjects(projectsValue), ...explicitVms.map(name => vmIdentity(name).project)])].sort();
  const vms = [...new Set([...explicitVms, ...projects.flatMap(project => PROVIDERS.map(provider => `${provider}-${project}`))])].sort();
  for (const name of vms) vmIdentity(name); // every derived name is itself a valid agent VM name (fail closed otherwise)
  return { projects, vms };
}

/** Projects reserved by a list of reserved VMs (for components that only receive VM names). */
export function projectsOfVms(vms: readonly string[]): Set<string> {
  return new Set(vms.map(projectOfVm).filter((project): project is string => project !== null));
}

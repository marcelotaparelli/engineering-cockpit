import type { Provider, Snapshot, Vm } from "./model.ts";
import type { ProjectGrants } from "./project-grants.ts";
import type { ExecutionService } from "./execution.ts";

/** Providers offered when the operator picks a project ("Claude Code ou Codex"). */
export const PICKER_PROVIDERS: readonly Provider[] = Object.freeze(["claude", "codex"]);

/**
 * Why an agent of a project can or cannot be opened from the picker. Never an instruction to create or start a VM: VMs are
 * reused as they are; a missing or stopped one is created/started outside the Cockpit (its launcher).
 */
export type AgentStatus = "ready" | "stopped" | "absent" | "reserved" | "unsupported" | "not_authorized" | "project_missing" | "unobserved";

export interface CatalogAgent { provider: Provider; vm_name: string; vm_state: Vm["state"] | "absent" | "unobserved"; status: AgentStatus }
export interface CatalogProject {
  name: string;
  /** Directory present in COCKPIT_PROJECTS_BASE at the last observation; null when discovery failed. */
  present: boolean | null;
  authorized: boolean;
  grant: "config" | "ui" | null;
  granted_at: string | null;
  reserved: boolean;
  /** In COCKPIT_ALLOWED_PROJECTS but reserved: that configuration grant has no effect (P-D4). */
  config_ignored: boolean;
  can_authorize: boolean;
  can_revoke: boolean;
  agents: CatalogAgent[];
}

/**
 * The project picker: every DISCOVERED project (a real directory of the projects base, no link) plus every AUTHORIZED one.
 * Discovery is shown, never trusted as authorization: `authorized` comes only from ProjectGrants. Names outside both sets
 * (e.g. an MSB VM of a project without a directory) are never listed. Sessions, runs, history and events stay grant-gated.
 */
export function buildCatalog(input: {
  snapshot: Snapshot | null;
  discoveryError: string | null;
  grants: ProjectGrants;
  execution?: Pick<ExecutionService, "supports" | "unsupportedReason"> | undefined;
  source: "mock" | "host";
}): Record<string, unknown> {
  const { snapshot, grants } = input;
  const discovered = new Set(snapshot?.projects ?? []);
  const names = [...new Set([...discovered, ...grants.view])].sort();
  const supported = (vm: Vm) => input.execution ? input.execution.supports(vm.provider, vm.vm_name) : vm.provider === "codex";
  const projects: CatalogProject[] = names.map(name => {
    const present = snapshot ? discovered.has(name) : null;
    const source = grants.source(name);
    const authorized = source !== null;
    const reserved = grants.reserved(name);
    const own = snapshot?.vms.filter(vm => vm.project === name) ?? [];
    const agents: CatalogAgent[] = PICKER_PROVIDERS.map(provider => {
      const vmName = `${provider}-${name}`;
      const vm = own.find(item => item.vm_name === vmName);
      if (!snapshot) return { provider, vm_name: vmName, vm_state: "unobserved", status: "unobserved" };
      if (!vm) return { provider, vm_name: vmName, vm_state: "absent", status: present ? "absent" : "project_missing" };
      return { provider, vm_name: vmName, vm_state: vm.state, status: reserved ? "reserved"
        : agentStatus(vm, present === true, authorized, supported(vm), input.execution?.unsupportedReason(vm.provider, vm.vm_name) ?? null) };
    });
    // Observed VMs of other providers (e.g. OpenCode): listed so the operator knows they exist, never openable here.
    for (const vm of own) {
      if (PICKER_PROVIDERS.includes(vm.provider)) continue;
      agents.push({ provider: vm.provider, vm_name: vm.vm_name, vm_state: vm.state, status: reserved ? "reserved" : "unsupported" });
    }
    return {
      name, present, authorized, grant: source, granted_at: authorized ? grants.grantedAt(name) : null, reserved, config_ignored: grants.configIgnored(name),
      can_authorize: grants.mutable && !authorized && !reserved && present === true,
      can_revoke: grants.mutable && source === "ui",
      agents,
    };
  });
  return {
    source: input.source,
    host_verification: "not_verified",
    observed_at: snapshot?.observed_at ?? null,
    discovery_error: input.discoveryError,
    ui_grants: grants.mutable,
    counts: { discovered: discovered.size, authorized: projects.filter(project => project.authorized).length },
    projects,
  };
}

function agentStatus(vm: Vm, present: boolean, authorized: boolean, supported: boolean, unsupported: "reserved" | "provider" | null): AgentStatus {
  if (!present || vm.orphaned) return "project_missing";
  if (!supported) return unsupported === "reserved" ? "reserved" : "unsupported";
  if (vm.state !== "running") return "stopped";
  if (!authorized) return "not_authorized";
  return "ready";
}

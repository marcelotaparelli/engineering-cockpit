import { parseVmInventory } from "./parser.ts";
import { vmNameIssue } from "./model.ts";

/** Terminal-safe rendering: printable ASCII only, everything else escaped, bounded length. */
export function safeName(value: string): string {
  const escaped = [...value].map(char => /^[\x20-\x7e]$/.test(char) && char !== "\\" ? char : `\\u{${char.codePointAt(0)!.toString(16)}}`).join("");
  return escaped.length > 96 ? escaped.slice(0, 96) + "…" : escaped;
}

/**
 * Local-only diagnosis for the operator: classifies every MSB record exactly as discovery does,
 * and says why an agent VM would not appear in the Cockpit. Read-only; prints to the operator's terminal.
 */
export function discoveryReport(output: string, projects: string[], allowed: string[]) {
  const inventory = parseVmInventory(output); // throws the same list-level codes as discovery
  let names: string[] = [];
  try {
    const json: unknown = JSON.parse(output.trim());
    if (Array.isArray(json)) names = json.map(row => String((row as { name?: unknown }).name));
  } catch { names = output.trim().split(/\r?\n/).slice(1).map(line => line.trim().split(/\s+/)[0] ?? ""); }
  const grants = new Set(allowed);
  const rows = names.map(name => {
    const issue = vmNameIssue(name);
    if (issue) return { name: safeName(name), shown: false, reason: issue };
    const vm = inventory.vms.find(item => item.vm_name === name)!;
    const reason = !grants.has(vm.project) ? "project_not_in_COCKPIT_ALLOWED_PROJECTS"
      : !projects.includes(vm.project) ? "project_directory_missing (orphan, not runnable)"
      : vm.provider !== "codex" ? "shown (provider not executable yet)"
      : vm.state !== "running" ? "shown (stopped: start it with its launcher)"
      : "shown (runnable)";
    return { name: vm.vm_name, provider: vm.provider, project: vm.project, state: vm.state, shown: grants.has(vm.project), reason };
  });
  return { records: rows.length, shown: rows.filter(row => row.shown).length, ignored: inventory.ignored, allowed_projects: allowed, rows };
}

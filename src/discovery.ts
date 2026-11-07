import { readFile } from "node:fs/promises";
import { listProjects } from "./projects.ts";
import { parseVmInventory, type VmInventory } from "./parser.ts";
import { SafeError, type Snapshot } from "./model.ts";
import type { SnapshotStore } from "./store.ts";

export interface DiscoveryOptions {
  source: "mock" | "host";
  projectsBase: string;
  readOutput: () => Promise<string>;
  store: SnapshotStore;
}
export function mockOutput(): Promise<string> {
  return readFile(new URL("../fixtures/msb/synthetic-table.txt", import.meta.url), "utf8");
}
export class Discovery {
  private pending: Promise<Snapshot> | null = null;
  private last: { at: number; snapshot: Snapshot } | null = null;
  /** Non-agent sandboxes skipped in the last successful observation (counts only). */
  ignored: VmInventory["ignored"] | null = null;
  constructor(private readonly options: DiscoveryOptions) {}
  /**
   * Display-only read: a successful observation younger than `maxAgeMs` is reused to spare MSB.
   * Never use for authorization or dispatch decisions — those call `refresh()`, which always observes.
   */
  cached(maxAgeMs = 3000): Promise<Snapshot> {
    if (this.last && Date.now() - this.last.at < maxAgeMs) return Promise.resolve(this.last.snapshot);
    return this.refresh();
  }
  refresh(): Promise<Snapshot> {
    if (this.pending) return this.pending;
    this.pending = this.collect().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async collect(): Promise<Snapshot> {
    const projects = await listProjects(this.options.projectsBase);
    const inventory = parseVmInventory(await this.options.readOutput());
    const discovered = inventory.vms;
    // Keep every valid MSB VM. Project directories remain an independent inventory;
    // a missing directory marks an orphan and never creates a fictional project.
    const vms = discovered
      .map(vm => ({ ...vm, orphaned: !projects.includes(vm.project) }))
      .sort((a, b) => a.vm_name < b.vm_name ? -1 : a.vm_name > b.vm_name ? 1 : 0);
    const snapshot: Snapshot = { source: this.options.source, observed_at: new Date().toISOString(), host_verification: "not_verified", projects, vms };
    try { this.options.store.replace(snapshot); } catch { throw new SafeError("snapshot_write_failed"); }
    this.ignored = inventory.ignored;
    this.last = { at: Date.now(), snapshot };
    return snapshot;
  }
}

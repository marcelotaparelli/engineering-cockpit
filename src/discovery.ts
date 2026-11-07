import { readFile } from "node:fs/promises";
import { listProjects } from "./projects.ts";
import { parseVmList } from "./parser.ts";
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
  constructor(private readonly options: DiscoveryOptions) {}
  refresh(): Promise<Snapshot> {
    if (this.pending) return this.pending;
    this.pending = this.collect().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async collect(): Promise<Snapshot> {
    const projects = await listProjects(this.options.projectsBase);
    const discovered = parseVmList(await this.options.readOutput());
    // Keep every valid MSB VM. Project directories remain an independent inventory;
    // a missing directory marks an orphan and never creates a fictional project.
    const vms = discovered
      .map(vm => ({ ...vm, orphaned: !projects.includes(vm.project) }))
      .sort((a, b) => a.vm_name < b.vm_name ? -1 : a.vm_name > b.vm_name ? 1 : 0);
    const snapshot: Snapshot = { source: this.options.source, observed_at: new Date().toISOString(), host_verification: "not_verified", projects, vms };
    try { this.options.store.replace(snapshot); } catch { throw new SafeError("snapshot_write_failed"); }
    return snapshot;
  }
}

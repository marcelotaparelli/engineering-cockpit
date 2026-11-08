import { readFileSync } from "node:fs";
import { safeCode, vmIdentity } from "./model.ts";
import type { MsbChild, MsbSpawn } from "./msb-transport.ts";
import type { ChildKind, ChildProcessRecord, RuntimeStore } from "./runtime-store.ts";

/**
 * E4 — which `msb exec` children outlived the Cockpit that spawned them.
 *
 * When the Cockpit dies abruptly (kill -9, crash, OOM), its children are re-parented and keep running: a Codex app-server or
 * a `claude -p` process may still be executing a turn inside the VM, unsupervised. A new prompt to the same session (Claude)
 * or VM (Codex app-server) would then run a SECOND agent beside the first. The kernel gives no handle on those processes to
 * the next Cockpit, so every child with a PID is written to the runtime database at spawn and removed when it exits; the next
 * start classifies what is left:
 *  - owner still alive (another live Cockpit, normally impossible with the database lease): left untouched;
 *  - child gone, or its PID now belongs to another process (different kernel start time): forgotten;
 *  - child alive with the same identity: an ORPHAN. It is reported (dashboard, log) and blocks new runs of its session/VM.
 * Orphans are never signalled by the Cockpit: what killing `msb exec` does inside the VM is not observable from here, so the
 * operator decides (`kill <pid>`). Each read re-probes, so an orphan that exits stops blocking at once.
 */
export interface ProcessIdentity { pid: number; startTicks: string }
export interface ProcProbe {
  /** Kernel start time of a live process (`/proc/<pid>/stat` field 22), or null when there is no such process. */
  startTicks(pid: number): string | null;
}
export interface OrphanProcess { pid: number; kind: ChildKind; vmName: string; providerSessionId: string | null; since: string; detectedAt: string }
export interface ProcessLedgerLog { event: "process.orphan_detected" | "process.ledger_failed" | "process.ledger_recovered"; outcome?: string; error_code?: string; pid?: number; kind?: ChildKind; count?: number }

export const procProbe: ProcProbe = {
  startTicks(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // `pid (comm) state ppid …`: comm may contain spaces/parentheses; fields resume after the LAST ')'. starttime is field 22.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const value = fields[19];
      return value && /^[0-9]{1,20}$/.test(value) ? value : null;
    } catch { return null; }
  },
};

/** What an msb argv runs: `msb exec --stream <vm> -- <command…>`. Null for anything the ledger does not know. */
export function classifyChild(argv: readonly string[]): { kind: ChildKind; vmName: string; providerSessionId: string | null } | null {
  if (argv[0] !== "msb" || argv[1] !== "exec" || argv[2] !== "--stream" || argv[4] !== "--") return null;
  const vmName = argv[3] ?? "";
  try { vmIdentity(vmName); } catch { return null; }
  const command = argv.slice(5);
  if (command[0] === "codex" && command[1] === "app-server") return { kind: "codex_app_server", vmName, providerSessionId: null };
  if (command[0] !== "claude") return null;
  if (!command.includes("-p")) return { kind: "claude_command", vmName, providerSessionId: null };
  const at = Math.max(command.indexOf("--resume"), command.indexOf("--session-id"));
  const id = at >= 0 ? command[at + 1] ?? null : null;
  return { kind: "claude_session", vmName, providerSessionId: id && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : null };
}

export class ProcessLedger {
  readonly #store: RuntimeStore;
  readonly #probe: ProcProbe;
  readonly #self: ProcessIdentity | null;
  readonly #now: () => Date;
  readonly #log: (entry: ProcessLedgerLog) => void;

  constructor(store: RuntimeStore, options: { probe?: ProcProbe; self?: ProcessIdentity; now?: () => Date; log?: (entry: ProcessLedgerLog) => void } = {}) {
    this.#store = store;
    this.#probe = options.probe ?? procProbe;
    const ticks = options.self ? options.self.startTicks : this.#probe.startTicks(process.pid);
    this.#self = options.self ?? (ticks ? { pid: process.pid, startTicks: ticks } : null);
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log ?? (entry => console.log(JSON.stringify(entry)));
  }

  /** False where process identity cannot be read (no /proc): nothing is tracked and nothing is ever reported as an orphan. */
  get available(): boolean { return this.#self !== null; }

  /** Startup classification of what previous owners left behind. */
  recover(): { orphans: number; forgotten: number; foreign: number } {
    const result = { orphans: 0, forgotten: 0, foreign: 0 };
    if (!this.#self) return result;
    const at = this.#now().toISOString();
    for (const row of this.#store.childProcesses()) {
      if (this.#mine(row)) continue;
      if (this.#probe.startTicks(row.ownerPid) === row.ownerStartTicks) { result.foreign++; continue; }
      if (this.#probe.startTicks(row.pid) !== row.startTicks) { this.#store.releaseChild(row.pid, row.startTicks); result.forgotten++; continue; }
      this.#store.markChildOrphaned(row.pid, row.startTicks, at);
      result.orphans++;
      this.#log({ event: "process.orphan_detected", pid: row.pid, kind: row.kind });
    }
    this.#log({ event: "process.ledger_recovered", count: result.orphans, outcome: `forgotten=${result.forgotten};foreign=${result.foreign}` });
    return result;
  }

  /** Wrap a spawn: children with a PID are recorded, and forgotten when they exit. Ledger failures never break the spawn. */
  track(spawn: MsbSpawn): MsbSpawn {
    return (argv, options) => {
      const child = spawn(argv, options);
      if (!this.#self) return child;
      try {
        const what = classifyChild(argv);
        const pid = (child as MsbChild & { pid?: unknown }).pid;
        const startTicks = typeof pid === "number" ? this.#probe.startTicks(pid) : null;
        if (what && typeof pid === "number" && startTicks) {
          this.#store.recordChild({ pid, startTicks, ownerPid: this.#self.pid, ownerStartTicks: this.#self.startTicks, ...what, createdAt: this.#now().toISOString() });
          const release = () => { try { this.#store.releaseChild(pid, startTicks); } catch (error) { this.#log({ event: "process.ledger_failed", outcome: "release", error_code: safeCode(error) }); } };
          child.exited.then(release, release);
        }
      } catch (error) { this.#log({ event: "process.ledger_failed", outcome: "record", error_code: safeCode(error) }); }
      return child;
    };
  }

  /** Orphans still alive now (re-probed; the ones that exited are forgotten). */
  orphans(): OrphanProcess[] {
    if (!this.#self) return [];
    const alive: OrphanProcess[] = [];
    let rows: ChildProcessRecord[];
    try { rows = this.#store.childProcesses(); } catch (error) { this.#log({ event: "process.ledger_failed", outcome: "read", error_code: safeCode(error) }); return []; }
    for (const row of rows) {
      if (row.orphanedAt === null) continue;
      if (this.#probe.startTicks(row.pid) !== row.startTicks) { this.#store.releaseChild(row.pid, row.startTicks); continue; }
      alive.push({ pid: row.pid, kind: row.kind, vmName: row.vmName, providerSessionId: row.providerSessionId, since: row.createdAt, detectedAt: row.orphanedAt });
    }
    return alive;
  }

  /**
   * The orphan that forbids a new run, if any: a Claude process of the same session (it may still be executing a turn of
   * that conversation), or a Codex app-server of the same VM (it serves every thread of the VM). One-shot probes never block.
   */
  blocking(vmName: string, providerSessionId: string): OrphanProcess | null {
    return this.orphans().find(orphan => orphan.vmName === vmName &&
      (orphan.kind === "codex_app_server" || (orphan.kind === "claude_session" && orphan.providerSessionId === providerSessionId))) ?? null;
  }

  #mine(row: ChildProcessRecord): boolean {
    return row.ownerPid === this.#self!.pid && row.ownerStartTicks === this.#self!.startTicks;
  }
}

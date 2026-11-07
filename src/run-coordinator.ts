import { SafeError } from "./model.ts";
import type { RunStatus } from "./provider.ts";
import { RuntimeStore, type BeginRunInput, type BeginRunResult, type RunRecord } from "./runtime-store.ts";

export class RunCoordinator {
  constructor(readonly store: RuntimeStore) {}

  begin(input: BeginRunInput): BeginRunResult { return this.store.beginRun(input); }

  markDispatching(runId: string, expectedVersion: number, occurredAt: string): RunRecord {
    return this.store.transition(runId, expectedVersion, "dispatching", occurredAt);
  }

  markProviderBound(runId: string, expectedVersion: number, providerRunId: string, occurredAt: string): RunRecord {
    return this.store.transition(runId, expectedVersion, "running", occurredAt, { providerRunId });
  }

  markTerminal(runId: string, expectedVersion: number, status: "completed" | "failed" | "interrupted", occurredAt: string, reasonCode?: string): RunRecord {
    return this.store.transition(runId, expectedVersion, status, occurredAt, reasonCode ? { reasonCode } : {});
  }

  markTransportLoss(runId: string, expectedVersion: number, occurredAt: string): RunRecord {
    const current = this.store.getRun(runId);
    if (!current) throw new SafeError("run_not_found");
    const uncertain: readonly RunStatus[] = ["dispatching", "running", "awaiting_approval"];
    if (!uncertain.includes(current.status)) throw new SafeError("invalid_run_transition");
    return this.store.transition(runId, expectedVersion, "unknown", occurredAt, { reasonCode: "transport_lost" });
  }
}

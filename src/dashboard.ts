import type { Snapshot } from "./model.ts";
import type { LocalPrincipal, LocalSecurity } from "./local-security.ts";
import type { RunRecord, RuntimeStore } from "./runtime-store.ts";
import type { ExecutionService } from "./execution.ts";
import { vmIdentity } from "./model.ts";

export type AgentState = "working" | "blocked" | "awaiting_approval" | "completed" | "failed" | "interrupted" | "unknown" | "idle" | "offline";

const NEXT_STEP: Readonly<Record<AgentState, string>> = {
  working: "Acompanhar ou interromper",
  blocked: "Agente travado: pediu algo que o Cockpit não suporta. Interrompa e reformule a tarefa",
  awaiting_approval: "Decidir aprovação pendente",
  completed: "Revisar resultado e enviar próximo prompt",
  failed: "Ver erro; reenviar só se fizer sentido",
  interrupted: "Retomar com novo prompt quando quiser",
  unknown: "Reconciliar: estado não confirmado, nada foi reenviado",
  idle: "Abrir sessão e enviar prompt",
  offline: "VM parada ou ausente: iniciar pelo launcher",
};

function vmProvider(vmName: string): string | null { return /^(codex|claude|opencode)-/.exec(vmName)?.[1] ?? null; }

function agentState(run: RunRecord | null, blocked: boolean): AgentState {
  if (!run) return "idle";
  switch (run.status) {
    case "running": return blocked ? "blocked" : "working";
    case "prepared": case "dispatching": return "working";
    case "awaiting_approval": return "awaiting_approval";
    default: return run.status;
  }
}

/** Single attention view: what is working, what finished, and what depends on the operator. */
export function buildDashboard(input: {
  store: RuntimeStore;
  execution: ExecutionService | undefined;
  principal: LocalPrincipal;
  security: LocalSecurity;
  snapshot: Snapshot | null;
  discoveryError: string | null;
  source: "mock" | "host";
  ignored?: { not_agent_vm: number; invalid_project_name: number } | null;
}): Record<string, unknown> {
  const { store, principal } = input;
  const grants = [...principal.grants];
  const sessions = store.listSessions(grants);
  const latestBySession = new Map(sessions.map(session => [session.sessionId, store.listRuns(session.sessionId, 1)[0] ?? null]));
  const sessionViews = sessions.map(session => {
    const run = latestBySession.get(session.sessionId) ?? null;
    return {
      session_id: session.sessionId, project: session.target.projectId, vm_name: session.target.vmName, thread_id: session.providerSessionId,
      last_activity: run && (run.endedAt ?? run.startedAt ?? run.createdAt) > session.lastObservedAt ? (run.endedAt ?? run.startedAt ?? run.createdAt) : session.lastObservedAt,
      latest_run: run ? { run_id: run.runId, status: run.status, reason_code: run.reasonCode, created_at: run.createdAt, ended_at: run.endedAt } : null,
      state: agentState(run, run !== null && (input.execution?.blockedRequests(run.runId).length ?? 0) > 0),
    };
  });

  const snapshot = input.snapshot ? input.security.visible(input.snapshot, principal) : null;
  const vmNames = new Set<string>([...(snapshot?.vms.map(vm => vm.vm_name) ?? []), ...sessionViews.map(view => view.vm_name)]);
  const vms = [...vmNames].sort().map(name => {
    const vm = snapshot?.vms.find(item => item.vm_name === name) ?? null;
    const forVm = sessionViews.filter(view => view.vm_name === name).sort((a, b) => b.last_activity.localeCompare(a.last_activity));
    const active = forVm.find(view => view.state === "working" || view.state === "blocked" || view.state === "awaiting_approval");
    const focus = active ?? forVm[0] ?? null;
    // Without an ExecutionService (display-only server) the historical Codex-only rule applies.
    const supported = vm !== null && (input.execution ? input.execution.supports(vm.provider, vm.vm_name) : vm.provider === "codex");
    const runnable = vm !== null && supported && vm.state === "running" && !vm.orphaned;
    let state: AgentState = focus?.state ?? "idle";
    if (!runnable && state === "idle") state = "offline";
    return {
      vm_name: name, project: vm?.project ?? focus?.project ?? null, provider: vm?.provider ?? vmProvider(name), vm_state: vm?.state ?? "unknown",
      orphaned: vm?.orphaned ?? false, runnable, capabilities: vm ? input.execution?.capabilities(vm.provider) ?? null : null, state, next_step: NEXT_STEP[state], session_id: focus?.session_id ?? null,
      run_id: focus?.latest_run?.run_id ?? null, last_activity: focus?.last_activity ?? null, sessions: forVm.length,
    };
  });

  const approvals = store.pendingApprovals().map(item => input.execution?.approvalView(item) ?? null)
    .filter((view): view is NonNullable<typeof view> => view !== null && principal.grants.has(view.projectId));
  const attention: Array<Record<string, unknown>> = [
    ...approvals.map(view => ({ kind: "approval", approval_id: view.approvalId, run_id: view.runId, session_id: view.sessionId, project: view.projectId,
      vm_name: view.vmName, provider: vmProvider(view.vmName), version: view.version, action_type: view.actionType, created_at: view.createdAt, summary: view.summary })),
    ...sessionViews.filter(view => view.state === "blocked").flatMap(view => (input.execution?.blockedRequests(view.latest_run!.run_id) ?? []).map(request => ({
      kind: "blocked", run_id: view.latest_run!.run_id, session_id: view.session_id, project: view.project, vm_name: view.vm_name,
      reason_code: "provider_request_unsupported", method: request.method, occurrences: request.occurrences,
      action: "interrupt_and_rephrase", created_at: request.since }))),
    ...sessionViews.filter(view => view.state === "unknown" || view.state === "failed").map(view => ({
      kind: view.state === "unknown" ? "unknown_run" : "failed_run", run_id: view.latest_run!.run_id, session_id: view.session_id,
      project: view.project, vm_name: view.vm_name, reason_code: view.latest_run!.reason_code, created_at: view.latest_run!.ended_at ?? view.latest_run!.created_at })),
  ];
  // E4: msb children of a previous Cockpit that are still alive. Shown with their PID: only the operator may end them.
  for (const orphan of input.execution?.orphanProcesses() ?? []) {
    let project: string;
    try { project = vmIdentity(orphan.vmName).project; } catch { continue; }
    if (!principal.grants.has(project)) continue;
    const session = orphan.providerSessionId ? sessions.find(item => item.target.vmName === orphan.vmName && item.providerSessionId === orphan.providerSessionId) ?? null : null;
    attention.push({ kind: "orphan_process", vm_name: orphan.vmName, project, provider: vmProvider(orphan.vmName), process_kind: orphan.kind, pid: orphan.pid,
      session_id: session?.sessionId ?? null, blocks: orphan.kind === "codex_app_server" ? "vm" : orphan.kind === "claude_session" ? "session" : "nothing",
      created_at: orphan.detectedAt, since: orphan.since });
  }
  const count = (state: AgentState) => sessionViews.filter(view => view.state === state).length;
  return {
    source: input.source,
    host_verification: "not_verified",
    observed_at: snapshot?.observed_at ?? null,
    discovery_error: input.discoveryError,
    // Diagnosis without inventory disclosure: counts only, never names outside the grants.
    discovery: {
      ok: input.snapshot !== null,
      observed_vms: input.snapshot?.vms.length ?? null,
      outside_grants: input.snapshot && snapshot ? input.snapshot.vms.length - snapshot.vms.length : null,
      ignored_not_agent: input.ignored?.not_agent_vm ?? 0,
      ignored_invalid_project: input.ignored?.invalid_project_name ?? 0,
    },
    projects: snapshot?.projects ?? grants,
    vms,
    sessions: sessionViews.slice(0, 100),
    attention,
    counts: { working: count("working"), blocked: count("blocked"), awaiting_approval: approvals.length, completed: count("completed"), failed: count("failed"),
      unknown: count("unknown"), interrupted: count("interrupted") },
    cursor: store.lastSequence(),
    // E4: what went wrong since this Cockpit started (codes and counts only).
    reliability: input.execution?.reliability() ?? null,
  };
}

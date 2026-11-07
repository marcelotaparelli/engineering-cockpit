import { createHash } from "node:crypto";
import { readHostVmList } from "./adapter.ts";
import { CodexAppServerAdapter } from "./codex-adapter.ts";
import { assertArchHost, hostFacts, type HostFacts } from "./host.ts";
import { SafeError, safeCode, vmIdentity } from "./model.ts";
import { MsbStdioTransport } from "./msb-transport.ts";
import { parseVmList } from "./parser.ts";
import type { ExecutionTarget, RpcTransport } from "./provider.ts";
import { assertRuntime } from "./runtime.ts";

type Result = "PASS" | "FAIL" | "NOT_VERIFIED";

export interface SmokeCheck {
  id: "runtime" | "host_consent" | "target_running" | "initialize" | "thread_list" | "close";
  status: Result;
  reason: string | null;
  duration_ms: number;
  provider?: "codex";
  server_version?: string;
  protocol_version?: string;
  sessions_returned?: 0 | 1;
}

export interface M0b1aSmokeReport {
  milestone: "M0b.1a";
  source: "host" | "synthetic";
  timestamp: string;
  overall: Result;
  checks: SmokeCheck[];
}

export interface M0b1aSmokeOverrides {
  facts: HostFacts;
  env: Record<string, string | undefined>;
  readOutput: () => Promise<string>;
  transportFactory: (target: ExecutionTarget) => RpcTransport | Promise<RpcTransport>;
}

function elapsed(started: number): number { return Math.max(0, Date.now() - started); }

function safeIdentity(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+:/-]{0,127}$/.test(value);
}

export async function runM0b1aSmoke(overrides?: M0b1aSmokeOverrides): Promise<M0b1aSmokeReport> {
  const checks: SmokeCheck[] = ["runtime", "host_consent", "target_running", "initialize", "thread_list", "close"]
    .map(id => ({ id: id as SmokeCheck["id"], status: "NOT_VERIFIED", reason: "not_exercised", duration_ms: 0 }));
  const report: M0b1aSmokeReport = {
    milestone: "M0b.1a",
    source: overrides ? "synthetic" : "host",
    timestamp: new Date().toISOString(),
    overall: "NOT_VERIFIED",
    checks,
  };
  const set = (id: SmokeCheck["id"], status: Result, reason: string | null, started: number, evidence?: Partial<SmokeCheck>): void => {
    const check = checks.find(row => row.id === id)!;
    Object.assign(check, { status, reason, duration_ms: elapsed(started) }, evidence ?? {});
  };
  const env = overrides?.env ?? process.env;
  const facts = overrides?.facts ?? hostFacts();
  let started = Date.now();
  try { assertRuntime(); set("runtime", "PASS", null, started); }
  catch (error) { set("runtime", "FAIL", safeCode(error), started); report.overall = "FAIL"; return report; }

  started = Date.now();
  try {
    assertArchHost(env, facts);
    if (env.COCKPIT_M0B1A_SMOKE_CONFIRMED !== "yes") throw new SafeError("smoke_confirmation_required");
    if (!env.COCKPIT_SMOKE_VM) throw new SafeError("smoke_target_required");
    const identity = vmIdentity(env.COCKPIT_SMOKE_VM);
    if (identity.provider !== "codex") throw new SafeError("smoke_target_invalid");
    set("host_consent", "PASS", null, started);
  } catch (error) {
    set("host_consent", "NOT_VERIFIED", safeCode(error), started);
    return report;
  }

  let target: ExecutionTarget;
  started = Date.now();
  try {
    const output = await (overrides?.readOutput ?? readHostVmList)();
    const vms = parseVmList(output);
    const vmName = env.COCKPIT_SMOKE_VM!;
    const selected = vms.find(vm => vm.vm_name === vmName);
    if (!selected) throw new SafeError("smoke_target_absent");
    if (selected.provider !== "codex") throw new SafeError("smoke_target_invalid");
    if (selected.state !== "running") throw new SafeError("smoke_target_not_running");
    target = {
      provider: "codex",
      projectId: selected.project,
      vmName,
      vmInstanceId: null,
      discoveryVersion: createHash("sha256").update(output).digest("hex"),
    };
    set("target_running", "PASS", null, started);
  } catch (error) {
    const code = safeCode(error);
    const unavailable = code === "smoke_target_absent" || code === "smoke_target_not_running";
    set("target_running", unavailable ? "NOT_VERIFIED" : "FAIL", code, started);
    report.overall = unavailable ? "NOT_VERIFIED" : "FAIL";
    return report;
  }

  const transportFactory = overrides?.transportFactory ?? ((value: ExecutionTarget) => new MsbStdioTransport(value.vmName));
  const adapter = new CodexAppServerAdapter(transportFactory);
  let connection: Awaited<ReturnType<typeof adapter.connect>> | undefined;
  let failed = false;
  try {
    started = Date.now();
    connection = await adapter.connect(target);
    const identity = await connection.initialize();
    if (identity.provider !== "codex" || !safeIdentity(identity.serverVersion) || !safeIdentity(identity.protocolVersion)) {
      throw new SafeError("smoke_protocol_identity_invalid");
    }
    set("initialize", "PASS", null, started, {
      provider: identity.provider,
      server_version: identity.serverVersion,
      protocol_version: identity.protocolVersion,
    });

    started = Date.now();
    const page = await connection.listSessions(undefined, 1);
    if (page.sessions.length > 1) throw new SafeError("smoke_session_limit_exceeded");
    set("thread_list", "PASS", null, started, { sessions_returned: page.sessions.length as 0 | 1 });
  } catch (error) {
    const check = connection && checks.find(row => row.id === "initialize")?.status === "PASS" ? "thread_list" : "initialize";
    set(check, "FAIL", safeCode(error), started);
    failed = true;
  } finally {
    if (connection) {
      started = Date.now();
      try { await connection.close(); set("close", "PASS", null, started); }
      catch (error) { set("close", "FAIL", safeCode(error), started); failed = true; }
    }
  }
  report.overall = failed ? "FAIL" : "PASS";
  return report;
}

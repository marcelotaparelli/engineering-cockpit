import { createHash } from "node:crypto";
import { readHostVmList } from "./adapter.ts";
import { INITIALIZE_FIELDS, SUPPORTED_CODEX_APP_SERVER_VERSIONS, USER_AGENT_TOKEN_PATTERN } from "./codex-adapter.ts";
import { assertArchHost, hostFacts, type HostFacts } from "./host.ts";
import { SafeError, safeCode, vmIdentity } from "./model.ts";
import { MsbStdioTransport } from "./msb-transport.ts";
import { parseVmList } from "./parser.ts";
import type { ExecutionTarget, RpcTransport } from "./provider.ts";
import { assertRuntime } from "./runtime.ts";

/**
 * E0 protocol diagnostic: initialize + thread/list(limit=1) only, against one already-running Codex VM.
 * It reports structural divergences (field NAMES, types, enum tags) and never values, ids, paths or content.
 * It deliberately does not reuse the adapter validators, so a version the adapter rejects can still be described.
 */
export type DiagnoseStatus = "PASS" | "FAIL" | "NOT_VERIFIED";
export interface Divergence { where: string; kind: "missing" | "unexpected_type" | "unknown_enum" | "additive"; name: string; blocking: boolean }
export interface ProtocolDiagnosis {
  milestone: "E0-diagnose";
  source: "host" | "synthetic";
  timestamp: string;
  overall: DiagnoseStatus;
  reason: string | null;
  server_version: string | null;
  version_pinned: boolean | null;
  divergences: Divergence[];
}
export interface DiagnoseOverrides {
  facts: HostFacts;
  env: Record<string, string | undefined>;
  readOutput: () => Promise<string>;
  transportFactory: (target: ExecutionTarget) => RpcTransport | Promise<RpcTransport>;
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const KNOWN_STATUS = new Set(["notLoaded", "idle", "systemError", "active"]);
function safeName(name: string): string { return SAFE_NAME.test(name) ? name : "<invalid-name>"; }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Pure comparison, exported for tests. `init`/`list` are raw provider results. */
export function compareShapes(init: unknown, list: unknown): { version: string | null; divergences: Divergence[] } {
  const out: Divergence[] = [];
  const add = (where: string, kind: Divergence["kind"], name: string, blocking: boolean): void => {
    if (out.length < 40) out.push({ where, kind, name: safeName(name), blocking });
  };
  let version: string | null = null;
  if (!isObject(init)) add("initialize", "unexpected_type", "result", true);
  else {
    for (const field of INITIALIZE_FIELDS) {
      if (!Object.hasOwn(init, field)) add("initialize", "missing", field, true);
      else if (typeof init[field] !== "string") add("initialize", "unexpected_type", field, true);
    }
    for (const key of Object.keys(init)) if (!(INITIALIZE_FIELDS as readonly string[]).includes(key)) add("initialize", "additive", key, true);
    if (typeof init.userAgent === "string") {
      const matches = [...init.userAgent.matchAll(USER_AGENT_TOKEN_PATTERN)];
      if (matches.length === 1) version = matches[0]![1] ?? null;
      else add("initialize.userAgent", "missing", "engineering_cockpit_token", true);
    }
  }
  if (!isObject(list)) add("thread/list", "unexpected_type", "result", true);
  else {
    if (!Array.isArray(list.data)) add("thread/list", "missing", "data", true);
    if (!Object.hasOwn(list, "nextCursor")) add("thread/list", "missing", "nextCursor", false);
    for (const key of Object.keys(list)) if (key !== "data" && key !== "nextCursor") add("thread/list", "additive", key, false);
    const row = Array.isArray(list.data) ? list.data[0] : undefined;
    if (isObject(row)) {
      if (typeof row.id !== "string") add("thread/list.data[]", "missing", "id", true);
      if (!Number.isSafeInteger(row.updatedAt)) add("thread/list.data[]", "unexpected_type", "updatedAt", true);
      const status = row.status;
      if (!isObject(status) || typeof status.type !== "string") add("thread/list.data[]", "unexpected_type", "status", true);
      else if (!KNOWN_STATUS.has(status.type)) add("thread/list.data[].status", "unknown_enum", "type", true);
      for (const key of Object.keys(row)) if (!["id", "status", "updatedAt"].includes(key)) add("thread/list.data[]", "additive", key, false);
    }
  }
  return { version, divergences: out };
}

export async function runProtocolDiagnosis(overrides?: DiagnoseOverrides): Promise<ProtocolDiagnosis> {
  const report: ProtocolDiagnosis = {
    milestone: "E0-diagnose", source: overrides ? "synthetic" : "host", timestamp: new Date().toISOString(),
    overall: "NOT_VERIFIED", reason: null, server_version: null, version_pinned: null, divergences: [],
  };
  const env = overrides?.env ?? process.env;
  try { assertRuntime(); } catch (error) { report.overall = "FAIL"; report.reason = safeCode(error); return report; }
  let target: ExecutionTarget;
  try {
    assertArchHost(env, overrides?.facts ?? hostFacts());
    if (env.COCKPIT_E0_DIAGNOSE_CONFIRMED !== "yes") throw new SafeError("diagnose_confirmation_required");
    if (!env.COCKPIT_DIAGNOSE_VM) throw new SafeError("diagnose_target_required");
    const identity = vmIdentity(env.COCKPIT_DIAGNOSE_VM);
    if (identity.provider !== "codex") throw new SafeError("diagnose_target_invalid");
    const output = await (overrides?.readOutput ?? readHostVmList)();
    const selected = parseVmList(output).find(vm => vm.vm_name === env.COCKPIT_DIAGNOSE_VM);
    if (!selected) throw new SafeError("diagnose_target_absent");
    if (selected.state !== "running") throw new SafeError("diagnose_target_not_running");
    target = { provider: "codex", projectId: selected.project, vmName: selected.vm_name, vmInstanceId: null,
      discoveryVersion: createHash("sha256").update(output).digest("hex") };
  } catch (error) { report.reason = safeCode(error); return report; }

  let transport: RpcTransport | undefined;
  try {
    transport = await (overrides?.transportFactory ?? ((value: ExecutionTarget) => new MsbStdioTransport(value.vmName)))(target);
    const init = await transport.request("initialize", {
      clientInfo: { name: "engineering-cockpit", title: "Engineering Cockpit", version: "m0b.1a" }, capabilities: {},
    });
    await transport.notify("initialized");
    const list = await transport.request("thread/list", { limit: 1 });
    const { version, divergences } = compareShapes(init, list);
    report.server_version = version && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
    report.version_pinned = version === null ? null : SUPPORTED_CODEX_APP_SERVER_VERSIONS.has(version);
    report.divergences = divergences;
    const blocking = divergences.some(item => item.blocking);
    report.overall = blocking || report.version_pinned !== true ? "FAIL" : "PASS";
    report.reason = blocking ? "structural_divergence" : report.version_pinned !== true ? "version_not_pinned" : null;
  } catch (error) { report.overall = "FAIL"; report.reason = safeCode(error); }
  finally { try { await transport?.close(); } catch { if (report.overall === "PASS") { report.overall = "FAIL"; report.reason = "close_failed"; } } }
  return report;
}

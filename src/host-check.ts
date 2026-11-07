import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertArchHost, hostFacts, type HostFacts } from "./host.ts";
import { assertRuntime } from "./runtime.ts";
import { config } from "./config.ts";
import { readHostVmList } from "./adapter.ts";
import { parseVmList } from "./parser.ts";
import { Discovery } from "./discovery.ts";
import { SnapshotStore } from "./store.ts";
import { assertNoSymlinks } from "./paths.ts";
import { startServer, type RequestLog } from "./server.ts";
import { LocalSecurity } from "./local-security.ts";
import { SafeError, safeCode } from "./model.ts";
import { artifactManifest } from "./artifact.ts";

type Result = "PASS" | "FAIL" | "NOT_VERIFIED";
interface Check { id: string; status: Result; reason: string | null }
export interface CheckOverrides {
  facts: HostFacts;
  env: Record<string, string | undefined>;
  readOutput: () => Promise<string>;
  databasePath: string;
}
// Overrides exist only for synthetic tests, and irreversibly label the report synthetic.
export async function runHostCheck(overrides?: CheckOverrides) {
  const checks: Check[] = ["runtime", "host_preflight", "msb_list", "parser", "discovery", "sqlite_reopen", "http_and_security", "real_vm_presence", "browser_visual", "msb_version"]
    .map(id => ({ id, status: "NOT_VERIFIED", reason: "not_exercised" }));
  const facts = overrides?.facts ?? hostFacts();
  const env = overrides?.env ?? process.env;
  const report = {
    project: "engineering-cockpit", milestone: "M0a.2", timestamp: new Date().toISOString(),
    source: overrides ? "synthetic" : "host", bun: Bun.version,
    os_id: /^ID=["']?([a-z0-9_-]+)/m.exec(facts.osRelease)?.[1] ?? "unknown",
    artifact_manifest_sha256: null as string | null,
    checks, counts: null as { projects: number; vms: number; orphaned_vms: number } | null,
    overall: "NOT_VERIFIED" as Result,
  };
  try { report.artifact_manifest_sha256 = createHash("sha256").update(await artifactManifest()).digest("hex"); } catch { /* Explicit null if unavailable; never reuse a stale manifest. */ }
  const set = (id: string, status: Result, reason: string | null = null) => Object.assign(checks.find(row => row.id === id)!, { status, reason });
  let active = "runtime";
  let store: SnapshotStore | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  try {
    assertRuntime(); set(active, "PASS"); active = "host_preflight";
    try { assertArchHost(env, facts); }
    catch (error) { set(active, "NOT_VERIFIED", safeCode(error)); return report; }
    const settings = config(env);
    set(active, "PASS"); active = "msb_list";
    const output = await (overrides?.readOutput ?? readHostVmList)();
    set(active, "PASS"); active = "parser";
    parseVmList(output); set(active, "PASS"); active = "discovery";
    const databasePath = overrides?.databasePath ?? settings.databasePath;
    assertNoSymlinks(databasePath);
    await mkdir(dirname(databasePath), { recursive: true });
    store = new SnapshotStore(databasePath);
    const discovery = new Discovery({ ...settings, store, readOutput: async () => output });
    const snapshot = await discovery.refresh();
    report.counts = { projects: snapshot.projects.length, vms: snapshot.vms.length, orphaned_vms: snapshot.vms.filter(vm => vm.orphaned).length };
    set(active, "PASS"); active = "sqlite_reopen";
    store.close(); store = undefined;
    store = new SnapshotStore(databasePath);
    const sorted = [...snapshot.vms].sort((a, b) => a.vm_name < b.vm_name ? -1 : a.vm_name > b.vm_name ? 1 : 0);
    if (!isDeepStrictEqual(store.read(), { ...snapshot, vms: sorted })) throw new SafeError("snapshot_reopen_mismatch");
    set(active, "PASS"); active = "http_and_security";
    const logs: RequestLog[] = [];
    // Serve the single observed snapshot: no further CLI call during policy checks.
    const grants = [...new Set([...snapshot.projects, ...snapshot.vms.map(vm => vm.project)])];
    const security = new LocalSecurity("a".repeat(64), grants.length ? grants : ["synthetic-empty"]);
    server = startServer({ source: "host", port: 0, discovery: { refresh: async () => snapshot }, security, log: row => logs.push(row) });
    const base = server.url.toString();
    const login = await fetch(base + "api/auth/login", { method: "POST", headers: { Origin: base.slice(0, -1), "Content-Type": "application/json" }, body: JSON.stringify({ credential: "a".repeat(64) }) });
    if (login.status !== 200) throw new SafeError("http_smoke_failed");
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new SafeError("http_smoke_failed");
    const proof = (await login.json() as { proof?: string }).proof;
    if (!proof) throw new SafeError("http_smoke_failed");
    for (const path of ["api/health", "api/vms", "api/projects", "", "app.js", "style.css"]) {
      const response = await fetch(base + path, { headers: { Cookie: cookie, "X-Session-Proof": proof } });
      if (response.status !== 200) throw new SafeError("http_smoke_failed");
      if (path === "api/vms" && JSON.stringify(await response.json()) !== JSON.stringify(snapshot)) throw new SafeError("http_snapshot_mismatch");
      if (!response.headers.get("x-request-id") || !response.headers.get("x-trace-id")) throw new SafeError("correlation_missing");
      if (!response.bodyUsed) await response.body?.cancel();
    }
    for (const [path, init, status] of [
      ["api/vms", { headers: { Origin: "https://invalid.example" } }, 403],
      ["api/vms?command=stop", {}, 400], ["api/exec", { method: "POST", headers: { Origin: base.slice(0, -1) } }, 405],
      [".env", {}, 404],
    ] as const) {
      const response = await fetch(base + path, init);
      if (response.status !== status) throw new SafeError("http_policy_failed");
      await response.body?.cancel();
    }
    if (logs.filter(row => row.event === "security_denied").length !== 4) throw new SafeError("security_signal_missing");
    const serialized = JSON.stringify(logs);
    if (snapshot.vms.some(vm => serialized.includes(vm.vm_name))) throw new SafeError("inventory_log_disclosure");
    set(active, "PASS");
    set("real_vm_presence", snapshot.vms.length > 0 ? "PASS" : "NOT_VERIFIED", snapshot.vms.length > 0 ? null : "no_authorized_vm_observed");
    set("browser_visual", "NOT_VERIFIED", "manual_browser_check_required");
    set("msb_version", "NOT_VERIFIED", "operator_version_evidence_required");
    const required = checks.filter(row => row.id !== "browser_visual" && row.id !== "msb_version");
    report.overall = required.every(row => row.status === "PASS") ? "PASS" : "NOT_VERIFIED";
  } catch (error) {
    set(active, "FAIL", safeCode(error)); report.overall = "FAIL";
  } finally { server?.stop(true); store?.close(); }
  return report;
}

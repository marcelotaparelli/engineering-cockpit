import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVmInventory, parseVmList } from "../src/parser.ts";
import { vmIdentity } from "../src/model.ts";
import { Discovery } from "../src/discovery.ts";
import { SnapshotStore } from "../src/store.ts";
import { RuntimeStore } from "../src/runtime-store.ts";
import { LocalSecurity } from "../src/local-security.ts";
import { startServer, type RequestLog } from "../src/server.ts";
import { discoveryReport, safeName } from "../src/discovery-report.ts";

/**
 * Regression for the first Arch visual test: `Discovery indisponível (invalid_vm_name)` and no agents.
 * Cause: `parseVmList` applied the agent-VM name grammar to *every* `msb list` record and threw on the
 * first sandbox that is not an agent VM (any `msb run --name devbox`, other tools), failing the whole
 * inventory — so even valid `codex-<project>` VMs disappeared.
 */
const row = (name: string, status = "Running") => ({ created_at: "2026-11-01T10:00:00.000000000+00:00", image: "node:22-bookworm-slim", name, status });
const hostList = JSON.stringify([
  row("codex-charybdis-nano"),            // observed on the Arch host
  row("claude-catus-2026", "Stopped"),    // observed on the Arch host
  row("devbox", "Stopped"),               // foreign sandbox: no provider prefix
  row("codex-Charybdis.Old"),             // provider prefix but project name outside the grammar
  row("codex-$(id)"),                     // hostile
]);

test("a foreign sandbox no longer fails the inventory; agent VMs are kept, the rest only counted", () => {
  // The strict grammar itself is unchanged: this is exactly the throw that used to escape for the whole list.
  expect(() => vmIdentity("devbox")).toThrow("invalid_vm_name");
  const inventory = parseVmInventory(hostList);
  expect(inventory.vms.map(vm => vm.vm_name)).toEqual(["codex-charybdis-nano", "claude-catus-2026"]);
  expect(inventory.ignored).toEqual({ not_agent_vm: 1, invalid_project_name: 2 });
  expect(parseVmList(hostList)).toEqual(inventory.vms);
});

test("list-level contract stays fail-closed", () => {
  expect(() => parseVmInventory(JSON.stringify([row("codex-a"), row("codex-a")]))).toThrow("duplicate_vm_name");
  expect(() => parseVmInventory(JSON.stringify([row("codex-a", "Paused")]))).toThrow("unsupported_vm_state");
  expect(() => parseVmInventory(JSON.stringify([{ ...row("devbox"), extra: 1 }]))).toThrow("invalid_vm_row");
});

const credential = "d".repeat(64);
let dir: string;
let store: SnapshotStore;
let runtime: RuntimeStore;
let server: ReturnType<typeof startServer>;
const logs: RequestLog[] = [];
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cockpit-discovery-"));
  await mkdir(join(dir, "projects", "charybdis-nano"), { recursive: true });
  await mkdir(join(dir, "projects", "catus-2026"), { recursive: true });
  store = new SnapshotStore(join(dir, "snapshot.sqlite"));
  runtime = new RuntimeStore(join(dir, "runtime", "runtime.sqlite"));
  const discovery = new Discovery({ source: "host", projectsBase: join(dir, "projects"), store, readOutput: async () => hostList });
  server = startServer({ source: "host", port: 0, security: new LocalSecurity(credential, ["charybdis-nano"]), runtime, discovery, log: entry => { logs.push(entry); } });
});
afterAll(async () => { server.stop(true); store.close(); runtime.close(); await rm(dir, { recursive: true, force: true }); });

test("MSB → discovery → grants → /api/dashboard shows the authorized VM and only counts the rest", async () => {
  const base = server.url.toString();
  const login = await fetch(base + "api/auth/login", { method: "POST", headers: { Origin: base.slice(0, -1), "Content-Type": "application/json" }, body: JSON.stringify({ credential }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const { proof } = await login.json() as { proof: string };
  const response = await fetch(base + "api/dashboard", { headers: { Cookie: cookie, "X-Session-Proof": proof } });
  expect(response.status).toBe(200);
  const text = await response.text();
  const data = JSON.parse(text) as { discovery_error: string | null; vms: Array<{ vm_name: string; runnable: boolean; project: string }>; discovery: Record<string, unknown> };
  expect(data.discovery_error).toBeNull();
  expect(data.vms).toEqual([expect.objectContaining({ vm_name: "codex-charybdis-nano", project: "charybdis-nano", runnable: true })]);
  expect(data.discovery).toEqual({ ok: true, observed_vms: 2, outside_grants: 1, ignored_not_agent: 1, ignored_invalid_project: 2 });
  for (const hidden of ["devbox", "Charybdis.Old", "$(id)", "catus"]) expect(text).not.toContain(hidden);
  expect(JSON.stringify(logs)).not.toContain("devbox");
});

test("operator discovery report explains every record without unsafe terminal output", () => {
  const report = discoveryReport(hostList, ["charybdis-nano", "catus-2026"], ["charybdis-nano"]);
  expect(report.shown).toBe(1);
  expect(report.rows.map(item => item.reason)).toEqual([
    "shown (runnable)", "project_not_in_COCKPIT_ALLOWED_PROJECTS", "not_agent_vm", "invalid_project_name", "invalid_project_name",
  ]);
  expect(safeName("codex-a\u001b[31m\n")).toBe("codex-a\\u{1b}[31m\\u{a}");
});

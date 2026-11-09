import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type GrantAuditLog } from "../src/server.ts";
import { LocalSecurity } from "../src/local-security.ts";
import { RuntimeStore } from "../src/runtime-store.ts";
import { EventHub } from "../src/event-hub.ts";
import { ExecutionService } from "../src/execution.ts";
import { CodexAppServerAdapter } from "../src/codex-adapter.ts";
import { ClaudeCodeAdapter } from "../src/claude-adapter.ts";
import { FakeCodexTransport, FakeCodexWorld } from "../src/fake-codex.ts";
import { fakeClaudeSpawn, newFakeWorld } from "../src/fake-claude.ts";
import { Discovery } from "../src/discovery.ts";
import { SnapshotStore } from "../src/store.ts";
import { GrantStore } from "../src/grant-store.ts";
import { ProjectGrants } from "../src/project-grants.ts";
import { reservations } from "../src/reservations.ts";
import type { OrphanProcess } from "../src/process-ledger.ts";

/**
 * P-D4 end to end with REAL discovery (temporary projects base) and the real HTTP + execution stack (simulated providers):
 *  - `COCKPIT_RESERVED_VMS=codex-beta` reserves project `beta` for EVERY provider, and wins over its configuration grant;
 *  - every route that could authorize, execute or show history refuses it, including sessions/runs/approvals created before;
 *  - a process left alive in it stays visible and is never ended by the Cockpit;
 *  - revocation, concurrency, CSRF, symlinks and file-system changes on the projects base.
 */
const credential = "f".repeat(64);
const work = await mkdtemp(join(tmpdir(), "cockpit-reservations-"));
const base = join(work, "projects");
for (const name of ["alpha", "beta", "gamma", "engineering-cockpit"]) await mkdir(join(base, name), { recursive: true });
await mkdir(join(work, "outside"));
let msb = ["claude-alpha", "codex-alpha", "claude-beta", "codex-beta", "codex-gamma", "claude-engineering-cockpit"].map(name => ({ name, status: "Running" }));
const msbJson = () => JSON.stringify(msb.map(row => ({ ...row, image: "synthetic", created_at: "2026-11-09T00:00:00Z" })));
const snapshots = new SnapshotStore(join(work, "snapshot.sqlite"));
const discovery = new Discovery({ source: "host", projectsBase: base, store: snapshots, readOutput: async () => msbJson() });
const runtime = new RuntimeStore(join(work, "runtime", "runtime.sqlite"));
const hub = new EventHub();
// The configuration a real start would compute from COCKPIT_RESERVED_VMS=codex-beta (P-D4 derivation included).
const reserved = reservations("codex-beta", undefined);
const orphans: OrphanProcess[] = [{ pid: 424242, kind: "codex_app_server", vmName: "codex-beta", providerSessionId: null, since: "2026-11-09T11:00:00.000Z", detectedAt: "2026-11-09T11:00:01.000Z" }];
const claudeWorld = newFakeWorld();
const execution = new ExecutionService({ store: runtime, hub, log: () => {}, refresh: () => discovery.refresh(), reservedVms: reserved.vms,
  processes: { blocking: () => null, orphans: () => orphans },
  adapters: [new CodexAppServerAdapter(() => new FakeCodexTransport(new FakeCodexWorld())), new ClaudeCodeAdapter({ reservedVms: reserved.vms, spawn: fakeClaudeSpawn(claudeWorld) })] });
const grantStore = new GrantStore(join(work, "grants.sqlite"));
const grants = ProjectGrants.managed({ config: ["alpha", "beta"], reserved: reserved.projects, store: grantStore });
const security = new LocalSecurity(credential, grants);
const audits: GrantAuditLog[] = [];
const server = startServer({ discovery, source: "host", port: 0, security, runtime, execution, hub, log: () => {}, audit: entry => { audits.push(entry); } });
const url = server.url.toString();
const origin = url.slice(0, -1);
afterAll(async () => { server.stop(true); await execution.close().catch(() => {}); runtime.close(); snapshots.close(); grantStore.close(); await rm(work, { recursive: true, force: true }); });

type Auth = { cookie: string; proof: string; csrf: string };
async function login(): Promise<Auth> {
  const response = await fetch(url + "api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ credential }) });
  return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, ...(await response.json() as { proof: string; csrf: string }) };
}
const op = await login();
const get = (path: string, auth: Auth = op) => fetch(url + path, { headers: { Cookie: auth.cookie, "X-Session-Proof": auth.proof } });
const post = (path: string, body: unknown, extra: Record<string, string> = {}, auth: Auth = op) => fetch(url + path, { method: "POST", body: JSON.stringify(body),
  headers: { Origin: origin, "Content-Type": "application/json", Cookie: auth.cookie, "X-Session-Proof": auth.proof, "X-CSRF-Token": auth.csrf,
    "X-Request-Nonce": crypto.randomUUID().replaceAll("-", "") + "nn", ...extra } });
const code = async (response: Response) => ((await response.json()) as { error?: { code: string } }).error?.code ?? null;
const at = "2026-11-09T12:00:00.000Z";

/** A session with one finished run and one `unknown` run holding a pending approval, written straight into the runtime store. */
function seed(project: string, vm: string): { sessionId: string; runId: string; approvalId: string } {
  const sessionId = `ses-${project}-${crypto.randomUUID().slice(0, 8)}`;
  runtime.createSession({ sessionId, target: { provider: vm.startsWith("claude-") ? "claude" : "codex", projectId: project, vmName: vm, vmInstanceId: null, discoveryVersion: "v1" },
    providerSessionId: `thread-${sessionId}`, createdAt: at, lastObservedAt: at });
  const done = runtime.beginRun({ runId: `run-${sessionId}-a`, sessionId, idempotencyKey: `key-${sessionId}-a`, requestDigest: "a".repeat(64), createdAt: at }).run;
  runtime.transition(done.runId, 1, "dispatching", at); runtime.transition(done.runId, 2, "unknown", at, { reasonCode: "transport_lost" });
  const approvalId = `apr-${sessionId}`;
  runtime.createApproval({ approvalId, runId: done.runId, actionType: "command", actionDigest: "c".repeat(64), createdAt: at, expiresAt: "2099-01-01T00:00:00.000Z" });
  return { sessionId, runId: done.runId, approvalId };
}
/** Every route that exposes or acts on a session/run/approval, with the status each returns. */
async function sessionMatrix(ids: { sessionId: string; runId: string; approvalId: string }): Promise<Record<string, number>> {
  return {
    session: (await get(`api/sessions/${ids.sessionId}`)).status,
    history: (await get(`api/sessions/${ids.sessionId}/history`)).status,
    send: (await post(`api/sessions/${ids.sessionId}/runs`, { prompt: "x" }, { "Idempotency-Key": `k-${crypto.randomUUID()}` })).status,
    run: (await get(`api/runs/${ids.runId}`)).status,
    interrupt: (await post(`api/runs/${ids.runId}/interrupt`, {})).status,
    reconcile: (await post(`api/runs/${ids.runId}/reconcile`, {})).status,
    decide: (await post(`api/approvals/${ids.approvalId}/decision`, { decision: "reject", expected_version: 1 })).status,
  };
}
const hidden = { session: 404, history: 404, send: 404, run: 404, interrupt: 404, reconcile: 404, decide: 404 };

test("derivation: a reserved VM reserves its project for every provider, through the validated name association", () => {
  expect(reserved.projects).toEqual(["beta", "engineering-cockpit"]);
  expect(reserved.vms).toEqual(["claude-beta", "claude-engineering-cockpit", "codex-beta", "codex-engineering-cockpit", "opencode-beta", "opencode-engineering-cockpit"]);
  expect(reservations("codex-foo-bar", undefined).projects).toEqual(["engineering-cockpit", "foo-bar"]); // the whole suffix, never a prefix
  expect(reservations(undefined, "vault").vms).toContain("claude-vault");
  expect(reservations("", "").projects).toEqual(["engineering-cockpit"]); // empty values can never lift the development reservation
  for (const bad of ["beta", "codex-Beta", "codex-../x"]) expect(() => reservations(bad, undefined)).toThrow("invalid_reserved_vms");
  expect(() => reservations(undefined, "../x")).toThrow("invalid_reserved_projects");
  expect(grants.ignoredConfig).toEqual(["beta"]);
});

test("a reserved project is refused on EVERY route — configuration grant ignored, earlier sessions/runs/approvals hidden, execution refused", async () => {
  const beta = seed("beta", "claude-beta");
  const alpha = seed("alpha", "claude-alpha");
  expect(await sessionMatrix(beta)).toEqual(hidden);
  // Positive control on an authorized project: the same requests reach the session (status codes other than 404).
  const control = await sessionMatrix(alpha);
  expect(control.session).toBe(200);
  expect(control.run).toBe(200);
  expect(control.history).toBe(200);
  for (const path of ["api/projects/beta", "api/vms/claude-beta", "api/vms/codex-beta", "api/vms/codex-beta/threads"]) expect((await get(path)).status).toBe(404);
  for (const vm of ["claude-beta", "codex-beta"]) expect(await code(await post("api/sessions", { vm_name: vm, mode: "new" }))).toBe("resource_not_found");
  expect(await code(await post("api/projects/beta/grant", { confirm: "beta" }))).toBe("project_reserved");
  expect(await code(await post("api/projects/beta/revoke", { confirm: "beta" }))).toBe("resource_not_found");
  const inventory = await (await get("api/vms")).json() as { projects: string[]; vms: Array<{ vm_name: string }> };
  expect(inventory.projects).toEqual(["alpha"]);
  expect(inventory.vms.map(vm => vm.vm_name)).toEqual(["claude-alpha", "codex-alpha"]);
  const approvals = await (await get("api/approvals")).json() as { approvals: Array<{ approvalId: string; projectId: string }> };
  expect(approvals.approvals.some(item => item.approvalId === beta.approvalId || item.projectId === "beta")).toBe(false);
  const dashboard = await (await get("api/dashboard")).json() as { sessions: Array<{ project: string }>; vms: Array<{ vm_name: string }>; attention: Array<Record<string, unknown>> };
  expect(new Set(dashboard.sessions.map(item => item.project))).toEqual(new Set(["alpha"]));
  expect(dashboard.vms.some(vm => vm.vm_name.endsWith("-beta"))).toBe(false);
  // The process left alive in the reserved project stays visible (never killed by the Cockpit), without its session.
  expect(dashboard.attention).toContainEqual(expect.objectContaining({ kind: "orphan_process", vm_name: "codex-beta", pid: 424242, reserved: true, session_id: null }));
  const catalog = await (await get("api/catalog")).json() as { projects: Array<Record<string, any>> };
  const card = catalog.projects.find(project => project.name === "beta")!;
  expect(card).toMatchObject({ reserved: true, authorized: false, grant: null, config_ignored: true, can_authorize: false, can_revoke: false });
  expect(card.agents.map((agent: { status: string }) => agent.status)).toEqual(["reserved", "reserved"]);
  // Execution layer on its own (no HTTP grant involved): every provider of the reserved project is refused before any spawn.
  await expect(execution.revalidate("claude-beta", "beta")).rejects.toThrow("target_unavailable");
  await expect(execution.revalidate("codex-beta", "beta")).rejects.toThrow("target_unavailable");
  expect(claudeWorld.spawned.filter(spawned => spawned.argv.includes("claude-beta"))).toEqual([]);
  // Live stream: an event of the reserved project is never delivered (positive control: one of alpha is).
  const controller = new AbortController();
  const stream = await fetch(url + "api/events", { headers: { Cookie: op.cookie, "X-Session-Proof": op.proof }, signal: controller.signal });
  const reader = stream.body!.getReader();
  let text = "";
  const pump = (async () => { try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); } } catch { /* aborted */ } })();
  await Bun.sleep(50);
  runtime.appendJournal({ eventId: "beta-canary", type: "operation.notice", runId: beta.runId, occurredAt: at, payload: { reasonCode: "beta_canary" } });
  runtime.appendJournal({ eventId: "alpha-canary", type: "operation.notice", runId: alpha.runId, occurredAt: at, payload: { reasonCode: "alpha_canary" } });
  hub.journal();
  await Bun.sleep(150);
  controller.abort(); await pump;
  expect(text).toContain("alpha_canary");
  expect(text).not.toContain("beta_canary");
});

test("revocation: sessions, runs and approvals that already exist become unreachable at once, nothing is killed, re-granting restores them", async () => {
  expect((await post("api/projects/gamma/grant", { confirm: "gamma" })).status).toBe(200);
  const gamma = seed("gamma", "codex-gamma");
  expect((await get(`api/sessions/${gamma.sessionId}`)).status).toBe(200);
  const second = await login(); // another open session of the same operator
  expect((await get(`api/runs/${gamma.runId}`, second)).status).toBe(200);
  expect((await post("api/projects/gamma/revoke", { confirm: "gamma" })).status).toBe(200);
  expect(await sessionMatrix(gamma)).toEqual(hidden);
  expect((await get(`api/runs/${gamma.runId}`, second)).status).toBe(404);
  expect(runtime.getRun(gamma.runId)!.status).toBe("unknown"); // nothing deleted, nothing moved, no process signalled
  expect(runtime.getApproval(gamma.approvalId)!.status).toBe("pending");
  expect(orphans).toHaveLength(1);
  expect((await post("api/projects/gamma/grant", { confirm: "gamma" })).status).toBe(200);
  expect((await get(`api/sessions/${gamma.sessionId}`)).status).toBe(200);
  expect((await post("api/projects/gamma/revoke", { confirm: "gamma" })).status).toBe(200);
});

test("concurrency: simultaneous grants make one change and one audit row; interleaved grant/revoke end consistent with the trail", async () => {
  const before = grantStore.audit(1000).length;
  const results = await Promise.all(Array.from({ length: 16 }, () => post("api/projects/gamma/grant", { confirm: "gamma" }).then(async r => [r.status, (await r.json() as { changed: boolean }).changed] as const)));
  expect(results.every(([status]) => status === 200)).toBe(true);
  expect(results.filter(([, changed]) => changed)).toHaveLength(1);
  expect(grantStore.audit(1000).length).toBe(before + 1);
  const mixed = await Promise.all(Array.from({ length: 20 }, (_, i) => post(`api/projects/gamma/${i % 2 ? "grant" : "revoke"}`, { confirm: "gamma" }).then(r => r.status)));
  expect(mixed.every(status => status === 200 || status === 404)).toBe(true);
  const trail = grantStore.audit(1000).slice(0, grantStore.audit(1000).length - before).reverse().filter(row => row.project === "gamma");
  for (let i = 1; i < trail.length; i++) expect(trail[i]!.action).not.toBe(trail[i - 1]!.action); // never two grants or two revokes in a row
  expect(grants.source("gamma")).toBe(trail.at(-1)!.action === "grant" ? "ui" : null); // memory = durable state = last audit row
  if (grants.source("gamma")) expect((await post("api/projects/gamma/revoke", { confirm: "gamma" })).status).toBe(200);
});

test("CSRF on revoke too: missing, foreign (other session's token), replayed, wrong content type, missing Origin — nothing changes", async () => {
  expect((await post("api/projects/gamma/grant", { confirm: "gamma" })).status).toBe(200);
  const other = await login();
  const trail = grantStore.audit(1000).length;
  expect(await code(await post("api/projects/gamma/revoke", { confirm: "gamma" }, { "X-CSRF-Token": "" }))).toBe("csrf_denied");
  expect(await code(await post("api/projects/gamma/revoke", { confirm: "gamma" }, { "X-CSRF-Token": other.csrf }))).toBe("csrf_denied");
  const nonce = "fixed-nonce-for-replay-0123456789";
  expect((await post("api/projects/gamma/revoke", { confirm: "wrong" }, { "X-Request-Nonce": nonce })).status).toBe(400);
  expect(await code(await post("api/projects/gamma/revoke", { confirm: "gamma" }, { "X-Request-Nonce": nonce }))).toBe("replay_denied");
  expect(await code(await post("api/projects/gamma/revoke", { confirm: "gamma" }, { "Content-Type": "text/plain" }))).toBe("content_type_denied");
  expect(await code(await fetch(url + "api/projects/gamma/revoke", { method: "POST", body: JSON.stringify({ confirm: "gamma" }), headers: { "Content-Type": "application/json",
    Cookie: op.cookie, "X-Session-Proof": op.proof, "X-CSRF-Token": op.csrf, "X-Request-Nonce": crypto.randomUUID() + "zz" } }))).toBe("request_origin_denied");
  expect(grants.source("gamma")).toBe("ui");
  expect(grantStore.audit(1000).length).toBe(trail);
  expect((await post("api/projects/gamma/revoke", { confirm: "gamma" })).status).toBe(200);
});

test("file system: a granted directory swapped for a symlink, deleted, renamed or recreated — execution follows the disk, grants never move", async () => {
  expect((await post("api/projects/gamma/grant", { confirm: "gamma" })).status).toBe(200);
  const before = (await post("api/sessions", { vm_name: "codex-gamma", mode: "new" }));
  expect(before.status).toBe(201);
  const sessionId = (await before.json() as { session_id: string }).session_id;
  // Swapped for a link to a directory outside the base: no longer a project; nothing can be opened or sent.
  await rename(join(base, "gamma"), join(work, "gamma-moved"));
  await symlink(join(work, "outside"), join(base, "gamma"));
  // The catalog is a display read (3 s cache); a fresh observation stands for "a few seconds later". Mutations always re-observe.
  const card = async () => (await discovery.refresh(), (await (await get("api/catalog")).json()) as { projects: Array<Record<string, any>> }).projects.find(project => project.name === "gamma");
  expect(await card()).toMatchObject({ present: false, authorized: true });
  expect(await code(await post("api/sessions", { vm_name: "codex-gamma", mode: "new" }))).toBe("resource_not_found");
  const runsBefore = runtime.listRuns(sessionId, 50).length;
  expect(await code(await post(`api/sessions/${sessionId}/runs`, { prompt: "x" }, { "Idempotency-Key": `k-${crypto.randomUUID()}` }))).toBe("target_unavailable");
  expect(runtime.listRuns(sessionId, 50)).toHaveLength(runsBefore);
  // A link can never be granted, even under a valid name.
  await symlink(join(work, "outside"), join(base, "delta"));
  expect(await code(await post("api/projects/delta/grant", { confirm: "delta" }))).toBe("resource_not_found");
  // Deleted: still authorized (by name), still nothing runnable. Recreated as a real directory: runnable again.
  await rm(join(base, "gamma"));
  expect(await card()).toMatchObject({ present: false, authorized: true });
  await rename(join(work, "gamma-moved"), join(base, "gamma"));
  expect((await card())!.agents.find((agent: { provider: string }) => agent.provider === "codex").status).toBe("ready");
  // Renamed: the new name is discovered but NOT authorized (a grant never follows a directory).
  await rename(join(base, "gamma"), join(base, "gamma-two"));
  msb = [...msb, { name: "codex-gamma-two", status: "Running" }];
  await discovery.refresh();
  const catalog = (await (await get("api/catalog")).json()) as { projects: Array<Record<string, any>> };
  expect(catalog.projects.find(project => project.name === "gamma-two")).toMatchObject({ authorized: false, can_authorize: true });
  expect(await code(await post("api/sessions", { vm_name: "codex-gamma-two", mode: "new" }))).toBe("resource_not_found");
  await rename(join(base, "gamma-two"), join(base, "gamma"));
  // The base itself replaced by a link: discovery fails closed, nothing can be granted.
  await rename(base, join(work, "projects-real"));
  await symlink(join(work, "projects-real"), base);
  const failed = await post("api/projects/alpha/grant", { confirm: "alpha" });
  expect(failed.status).toBe(503);
  await expect(discovery.refresh()).rejects.toThrow("symlink_path_denied");
  // Every authoritative route fails closed (the catalog may show the last good observation for up to 3 s, display only).
  expect((await post("api/sessions", { vm_name: "codex-alpha", mode: "new" })).status).toBe(503);
  await rm(base); await rename(join(work, "projects-real"), base);
  expect((await post("api/projects/gamma/revoke", { confirm: "gamma" })).status).toBe(200);
  expect(audits.every(entry => !JSON.stringify(entry).includes(op.csrf))).toBe(true);
});

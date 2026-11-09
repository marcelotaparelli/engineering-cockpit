import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type GrantAuditLog, type RequestLog } from "../src/server.ts";
import { LocalSecurity } from "../src/local-security.ts";
import { RuntimeStore } from "../src/runtime-store.ts";
import { Discovery } from "../src/discovery.ts";
import { SnapshotStore } from "../src/store.ts";
import { GrantStore } from "../src/grant-store.ts";
import { ProjectGrants, reservedProjects } from "../src/project-grants.ts";
import { SafeError } from "../src/model.ts";
import { EventHub } from "../src/event-hub.ts";

/**
 * The whole path with REAL discovery: directories under a temporary projects base (one of them a symlink to a directory
 * outside it), an MSB list with VMs of discovered, undiscovered and reserved projects, the real HTTP security stack and a real
 * grant store. Nothing here can create or start a VM: the only MSB input is the static list below.
 */
const credential = "d".repeat(64);
const work = await mkdtemp(join(tmpdir(), "cockpit-grants-http-"));
const base = join(work, "projects");
for (const name of ["alpha", "beta", "engineering-cockpit", "Not_Valid"]) await mkdir(join(base, name), { recursive: true });
await mkdir(join(work, "outside"));
await symlink(join(work, "outside"), join(base, "linked"));
const msb = [
  { name: "claude-alpha", status: "Running" }, { name: "codex-alpha", status: "Stopped" }, { name: "codex-beta", status: "Running" },
  { name: "codex-linked", status: "Running" }, { name: "codex-ghost", status: "Running" }, { name: "claude-engineering-cockpit", status: "Running" },
].map(row => ({ ...row, image: "synthetic", created_at: "2026-11-09T00:00:00Z" }));
let msbFails = false;
const store = new SnapshotStore(join(work, "snapshot.sqlite"));
const discovery = new Discovery({ source: "host", projectsBase: base, store, readOutput: async () => { if (msbFails) throw new SafeError("msb_timeout"); return JSON.stringify(msb); } });
const runtime = new RuntimeStore(join(work, "runtime", "runtime.sqlite"));
const grantPath = join(work, "grants.sqlite");
const grantStore = new GrantStore(grantPath);
const grants = ProjectGrants.managed({ config: ["beta"], reserved: reservedProjects(undefined), store: grantStore });
const security = new LocalSecurity(credential, grants);
const logs: RequestLog[] = [];
const audits: GrantAuditLog[] = [];
const hub = new EventHub();
const server = startServer({ discovery, source: "host", port: 0, security, runtime, hub, log: entry => { logs.push(entry); }, audit: entry => { audits.push(entry); } });
const url = server.url.toString();
const origin = url.slice(0, -1);
afterAll(async () => { server.stop(true); runtime.close(); store.close(); grantStore.close(); await rm(work, { recursive: true, force: true }); });

async function login() {
  const response = await fetch(url + "api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ credential }) });
  const body = await response.json() as { csrf: string; proof: string };
  return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, ...body };
}
const operator = await login();
const read = (path: string) => fetch(url + path, { headers: { Cookie: operator.cookie, "X-Session-Proof": operator.proof } });
let nonces = 0;
const nonce = () => `nonce-${String(++nonces).padStart(4, "0")}-abcdefghijklmnop`;
function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url + path, { method: "POST", body: JSON.stringify(body), headers: { Origin: origin, "Content-Type": "application/json", Cookie: operator.cookie,
    "X-Session-Proof": operator.proof, "X-CSRF-Token": operator.csrf, "X-Request-Nonce": nonce(), ...headers } });
}
const code = async (response: Response) => ((await response.json()) as { error?: { code: string } }).error?.code;
const catalog = async () => (await (await read("api/catalog")).json()) as { projects: Array<{ name: string; authorized: boolean; grant: string | null; agents: Array<{ vm_name: string; status: string }> }> };

test("catalog requires the local session and lists only real, valid project directories (no link, no VM-only name)", async () => {
  expect((await fetch(url + "api/catalog")).status).toBe(401);
  const view = await catalog();
  expect(view.projects.map(project => project.name)).toEqual(["alpha", "beta", "engineering-cockpit"]);
  const alpha = view.projects.find(project => project.name === "alpha")!;
  expect(alpha.authorized).toBe(false);
  expect(alpha.agents.map(agent => `${agent.vm_name}:${agent.status}`)).toEqual(["claude-alpha:unsupported", "codex-alpha:stopped"]); // no ExecutionService: Codex-only rule
  expect(view.projects.find(project => project.name === "beta")!.grant).toBe("config");
  // Discovered is not authorized: the operational API still hides alpha completely.
  expect(((await (await read("api/vms")).json()) as { vms: Array<{ vm_name: string }> }).vms.map(vm => vm.vm_name)).toEqual(["codex-beta"]);
  expect((await read("api/projects/alpha")).status).toBe(404);
});

test("grant is a protected mutation: origin, CSRF, single-use nonce, exact body naming the project, POST only", async () => {
  const before = grantStore.audit().length;
  expect(await code(await post("api/projects/alpha/grant", { confirm: "alpha" }, { Origin: "http://evil.example" }))).toBe("request_origin_denied");
  expect(await code(await post("api/projects/alpha/grant", { confirm: "alpha" }, { "X-CSRF-Token": "x".repeat(43) }))).toBe("csrf_denied");
  expect(await code(await post("api/projects/alpha/grant", { confirm: "beta" }))).toBe("invalid_body");
  expect(await code(await post("api/projects/alpha/grant", {}))).toBe("invalid_body");
  expect(await code(await post("api/projects/alpha/grant", { confirm: "alpha", extra: true }))).toBe("invalid_body");
  expect(await code(await fetch(url + "api/projects/alpha/grant", { method: "POST", body: JSON.stringify({ confirm: "alpha" }), headers: { Origin: origin, "Content-Type": "application/json",
    Cookie: operator.cookie, "X-CSRF-Token": operator.csrf, "X-Request-Nonce": nonce() } }))).toBe("authentication_required"); // no session proof
  expect((await read("api/projects/alpha/grant")).status).toBe(405);
  const replayed = "replayed-nonce-0123456789abcdef";
  expect((await post("api/projects/alpha/grant", { confirm: "beta" }, { "X-Request-Nonce": replayed })).status).toBe(400);
  expect(await code(await post("api/projects/alpha/grant", { confirm: "alpha" }, { "X-Request-Nonce": replayed }))).toBe("replay_denied");
  expect(grantStore.audit().length).toBe(before);
  expect(grants.source("alpha")).toBeNull();
});

test("only a project discovered NOW can be authorized; reserved, linked, invented and VM-only names are refused", async () => {
  expect(await code(await post("api/projects/engineering-cockpit/grant", { confirm: "engineering-cockpit" }))).toBe("project_reserved");
  expect(logs.at(-1)).toMatchObject({ route: "/api/projects/:id/grant", status: 403, event: "security_denied", error_code: "project_reserved" });
  expect(await code(await post("api/projects/linked/grant", { confirm: "linked" }))).toBe("resource_not_found");
  expect(await code(await post("api/projects/ghost/grant", { confirm: "ghost" }))).toBe("resource_not_found");
  expect(await code(await post("api/projects/nowhere/grant", { confirm: "nowhere" }))).toBe("resource_not_found");
  // Outside the name grammar there is no route at all (unmatched POST → 405), so nothing reaches the grants.
  expect(await code(await post("api/projects/Not_Valid/grant", { confirm: "Not_Valid" }))).toBe("method_not_allowed");
  expect(await code(await post("api/projects/..%2Fetc/grant", { confirm: "../etc" }))).toBe("method_not_allowed");
  msbFails = true;
  const failed = await post("api/projects/alpha/grant", { confirm: "alpha" });
  msbFails = false;
  expect(failed.status).toBe(503); // discovery unavailable grants nothing
  expect(grantStore.list()).toEqual([]);
  expect(audits).toEqual([]);
});

test("authorize → the project becomes operable for the existing session at once, is audited, and is persisted", async () => {
  const granted = await post("api/projects/alpha/grant", { confirm: "alpha" });
  expect(granted.status).toBe(200);
  expect(await granted.json()).toEqual({ project: "alpha", action: "grant", changed: true, authorized: true, grant: "ui" });
  expect(((await (await read("api/vms")).json()) as { vms: Array<{ vm_name: string }> }).vms.map(vm => vm.vm_name)).toEqual(["claude-alpha", "codex-alpha", "codex-beta"]);
  expect((await read("api/projects/alpha")).status).toBe(200);
  const again = await post("api/projects/alpha/grant", { confirm: "alpha" });
  expect((await again.json() as { changed: boolean }).changed).toBe(false);
  const trail = grantStore.audit();
  expect(trail.map(row => [row.action, row.project])).toEqual([["grant", "alpha"]]);
  expect(trail[0]!.actor).toMatch(/^local_operator:[a-f0-9]{16}$/);
  expect(trail[0]!.requestId).toBe(granted.headers.get("x-request-id")!);
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ event: "project_grant", action: "grant", project: "alpha", actor: trail[0]!.actor });
  for (const secret of [operator.cookie.split("=")[1]!, operator.proof, operator.csrf]) {
    expect(JSON.stringify(audits)).not.toContain(secret);
    expect(JSON.stringify(trail)).not.toContain(secret);
  }
  // A restart (new store + grants over the same file) keeps it.
  const reopened = ProjectGrants.managed({ config: ["beta"], reserved: reservedProjects(undefined), store: new GrantStore(join(work, "copy-check.sqlite")) });
  expect(reopened.source("alpha")).toBeNull(); // a different file knows nothing
  const second = new GrantStore(grantPath);
  try { expect(ProjectGrants.managed({ config: ["beta"], reserved: reservedProjects(undefined), store: second }).source("alpha")).toBe("ui"); }
  finally { second.close(); }
});

test("revoke: configuration grants stay; work in flight blocks it; afterwards the project's sessions are hidden again", async () => {
  expect(await code(await post("api/projects/beta/revoke", { confirm: "beta" }))).toBe("grant_from_config");
  expect(await code(await post("api/projects/engineering-cockpit/revoke", { confirm: "engineering-cockpit" }))).toBe("resource_not_found");
  const at = "2026-11-09T12:00:00.000Z";
  runtime.createSession({ sessionId: "ses-alpha", target: { provider: "codex", projectId: "alpha", vmName: "codex-alpha", vmInstanceId: null, discoveryVersion: "v1" },
    providerSessionId: "thread-alpha", createdAt: at, lastObservedAt: at });
  const run = runtime.beginRun({ runId: "run-alpha", sessionId: "ses-alpha", idempotencyKey: "key-alpha-0000000", requestDigest: "e".repeat(64), createdAt: at }).run;
  runtime.transition(run.runId, 1, "dispatching", at);
  const visible = await read("api/sessions/ses-alpha");
  expect([visible.status, await visible.text()]).toEqual([200, expect.any(String)]);
  const busy = await post("api/projects/alpha/revoke", { confirm: "alpha" });
  expect(busy.status).toBe(409);
  expect(await code(busy)).toBe("project_busy");
  expect(grants.source("alpha")).toBe("ui");
  runtime.transition(run.runId, 2, "unknown", at, { reasonCode: "transport_lost" });
  const revoked = await post("api/projects/alpha/revoke", { confirm: "alpha" });
  expect(revoked.status).toBe(200);
  expect(await revoked.json()).toEqual({ project: "alpha", action: "revoke", changed: true, authorized: false, grant: null });
  expect((await read("api/sessions/ses-alpha")).status).toBe(404);
  expect((await read("api/runs/run-alpha")).status).toBe(404);
  expect((await read("api/projects/alpha")).status).toBe(404);
  expect(grantStore.audit().map(row => [row.action, row.project])).toEqual([["revoke", "alpha"], ["grant", "alpha"]]);
  expect(audits.at(-1)).toMatchObject({ action: "revoke", project: "alpha" });
  // Revoking is not deleting: authorizing again brings the same session back.
  expect((await post("api/projects/alpha/grant", { confirm: "alpha" })).status).toBe(200);
  expect((await read("api/sessions/ses-alpha")).status).toBe(200);
});

test("live event stream: a revocation stops journal delivery for that project on an already open stream", async () => {
  const controller = new AbortController();
  const response = await fetch(url + "api/events", { headers: { Cookie: operator.cookie, "X-Session-Proof": operator.proof }, signal: controller.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const pump = (async () => { try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value); } } catch { /* aborted */ } })();
  await Bun.sleep(50);
  // Positive control: while authorized, the same kind of event IS delivered on this stream.
  runtime.appendJournal({ eventId: "canary-before-revoke", type: "operation.notice", runId: "run-alpha", occurredAt: "2026-11-09T12:00:01.000Z", payload: { reasonCode: "canary_before_revoke" } });
  hub.journal();
  await Bun.sleep(100);
  expect(text).toContain("canary_before_revoke");
  expect((await post("api/projects/alpha/revoke", { confirm: "alpha" })).status).toBe(200);
  runtime.appendJournal({ eventId: "canary-after-revoke", type: "operation.notice", runId: "run-alpha", occurredAt: "2026-11-09T12:00:02.000Z", payload: { reasonCode: "canary_after_revoke" } });
  hub.journal();
  await Bun.sleep(150);
  controller.abort();
  await pump;
  expect(text).not.toContain("canary_after_revoke");
});

import { afterAll, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { cockpitHarness, type CockpitHarness } from "./support/cockpit-process.ts";

/**
 * The real `src/index.ts` (mock mode: simulated agents, no msb, no VM, no quota) started WITHOUT COCKPIT_ALLOWED_PROJECTS:
 * the operator sees the discovered projects, authorizes one from the API the page uses, picks Codex or Claude Code and opens a
 * session; the authorization survives a restart. With UI grants off the old rule (a non-empty configuration) still applies.
 */
const harnesses: CockpitHarness[] = [];
afterAll(async () => { for (const harness of harnesses) await harness.dispose(); });

async function client(origin: string, token: string) {
  const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ credential: token }) });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const { proof, csrf } = await login.json() as { proof: string; csrf: string };
  let n = 0;
  return {
    get: async (path: string) => { const response = await fetch(origin + path, { headers: { Cookie: cookie, "X-Session-Proof": proof } }); return { status: response.status, body: await response.json() as any }; },
    post: async (path: string, body: unknown) => {
      const response = await fetch(origin + path, { method: "POST", body: JSON.stringify(body), headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie,
        "X-Session-Proof": proof, "X-CSRF-Token": csrf, "X-Request-Nonce": `startup-nonce-${++n}-0123456789abcdef` } });
      return { status: response.status, body: await response.json() as any };
    },
  };
}

test("no configured project: discover → authorize in the page → open Codex and Claude Code sessions → still authorized after a restart", async () => {
  const harness = await cockpitHarness({ projects: "" });
  harnesses.push(harness);
  let cockpit = await harness.start();
  let api = await client(cockpit.origin, cockpit.token);
  const before = await api.get("/api/catalog");
  expect(before.status).toBe(200);
  expect(before.body.projects.map((project: { name: string; authorized: boolean }) => [project.name, project.authorized])).toEqual([["demo", false], ["lab", false]]);
  expect((await api.get("/api/dashboard")).body.vms).toEqual([]);
  expect((await api.post("/api/sessions", { vm_name: "codex-demo", mode: "new" })).status).toBe(404); // discovered, not authorized
  const granted = await api.post("/api/projects/demo/grant", { confirm: "demo" });
  expect(granted).toEqual({ status: 200, body: { project: "demo", action: "grant", changed: true, authorized: true, grant: "ui" } });
  const after = (await api.get("/api/catalog")).body.projects.find((project: { name: string }) => project.name === "demo");
  expect(after.agents.map((agent: { vm_name: string; status: string }) => `${agent.vm_name}:${agent.status}`)).toEqual(["claude-demo:ready", "codex-demo:ready"]);
  const codex = await api.post("/api/sessions", { vm_name: "codex-demo", mode: "new" });
  expect(codex.status).toBe(201);
  expect(codex.body).toMatchObject({ project: "demo", vm_name: "codex-demo", provider: "codex" });
  const claude = await api.post("/api/sessions", { vm_name: "claude-demo", mode: "new" });
  expect(claude.status).toBe(201);
  expect(claude.body).toMatchObject({ project: "demo", vm_name: "claude-demo", provider: "claude" });
  expect((await stat(join(harness.dataDir, "grants-mock.sqlite"))).mode & 0o777).toBe(0o600);
  const logs = cockpit.logs();
  expect(logs).toContain('"event":"project_grant","action":"grant","project":"demo"');
  expect(logs).not.toContain(harness.token);

  expect(await cockpit.stop("SIGTERM")).toEqual({ code: 0, signal: null });
  cockpit = await harness.start();
  api = await client(cockpit.origin, cockpit.token);
  const restarted = (await api.get("/api/catalog")).body.projects.map((project: { name: string; grant: string | null }) => [project.name, project.grant]);
  expect(restarted).toEqual([["demo", "ui"], ["lab", null]]);
  expect((await api.get(`/api/sessions/${codex.body.session_id}`)).status).toBe(200);
  await cockpit.stop("SIGTERM");
});

test("UI grants off: the configuration must still grant a project, and nothing can be authorized from the page", async () => {
  const empty = await cockpitHarness({ projects: "" });
  harnesses.push(empty);
  let message = "";
  try { await empty.start({ COCKPIT_UI_GRANTS: "off" }); } catch (error) { message = (error as Error).message; }
  expect(message).toContain("local_grants_required");
  const configured = await cockpitHarness({ projects: "demo" });
  harnesses.push(configured);
  const cockpit = await configured.start({ COCKPIT_UI_GRANTS: "off" });
  const api = await client(cockpit.origin, cockpit.token);
  const view = (await api.get("/api/catalog")).body;
  expect(view.ui_grants).toBe(false);
  expect(view.projects.map((project: { name: string; can_authorize: boolean }) => [project.name, project.can_authorize])).toEqual([["demo", false], ["lab", false]]);
  expect(await api.post("/api/projects/lab/grant", { confirm: "lab" })).toEqual({ status: 409, body: expect.objectContaining({ error: { code: "grants_read_only" } }) });
  expect(await Bun.file(join(configured.dataDir, "grants-mock.sqlite")).exists()).toBe(false);
  await cockpit.stop("SIGTERM");
});

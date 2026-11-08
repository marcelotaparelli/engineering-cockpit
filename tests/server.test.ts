import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RequestLog } from "../src/server.ts";
import { LocalSecurity } from "../src/local-security.ts";
import { RuntimeStore } from "../src/runtime-store.ts";
import { SafeError, type Snapshot } from "../src/model.ts";

const credential = "a".repeat(64);
const logs: RequestLog[] = [];
let fail = false;
let calls = 0;
const snapshot: Snapshot = { source: "mock", host_verification: "not_verified", observed_at: "2026-10-25T00:00:00.000Z",
  projects: ["private-project", "other-project"], vms: [
    { vm_name: "codex-private-project", project: "private-project", provider: "codex", state: "running", orphaned: false },
    { vm_name: "codex-other-project", project: "other-project", provider: "codex", state: "running", orphaned: false },
  ] };
const dir = await mkdtemp(join(tmpdir(), "cockpit-http-"));
const runtime = new RuntimeStore(join(dir, "runtime.sqlite"));
const now = "2026-10-25T00:00:00.000Z";
for (const project of ["private-project", "other-project"]) {
  runtime.createSession({ sessionId: `session-${project}`, target: { provider: "codex", projectId: project,
    vmName: `codex-${project}`, vmInstanceId: null, discoveryVersion: "v1" },
    providerSessionId: `provider-${project}`, createdAt: now, lastObservedAt: now });
  const run = runtime.beginRun({ runId: `run-${project}`, sessionId: `session-${project}`,
    idempotencyKey: `key-${project}`, requestDigest: "b".repeat(64), createdAt: now }).run;
  if (project === "private-project") {
    runtime.transition(run.runId, 1, "dispatching", now);
    runtime.transition(run.runId, 2, "unknown", now, { reasonCode: "transport_lost" });
  }
}
const security = new LocalSecurity(credential, ["private-project"]);
const server = startServer({ source: "mock", port: 0, security, runtime, log: entry => { logs.push(entry); },
  discovery: { refresh: async () => { calls++; if (fail) throw new SafeError("msb_timeout"); return snapshot; } } });
const base = server.url.toString();
const origin = base.slice(0, -1);
afterAll(async () => { server.stop(true); runtime.close(); await rm(dir, { recursive: true, force: true }); });
async function login(value = credential) {
  const response = await fetch(base + "api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ credential: value }) });
  const body = await response.json();
  return { response, body, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
const auth = (cookie: string, proof: string) => ({ Cookie: cookie, "X-Session-Proof": proof });

test("binds loopback; public health and assets expose no inventory", async () => {
  expect(server.hostname).toBe("127.0.0.1");
  expect((await fetch(base + "api/health")).status).toBe(200);
  expect((await fetch(base)).status).toBe(200);
  const before = calls;
  expect((await fetch(base + "api/vms")).status).toBe(401);
  const denied = await fetch(base + "api/projects", { headers: { "X-Request-Id": "untrusted-canary" } });
  expect(denied.status).toBe(401);
  expect(logs.at(-1)?.event).toBe("auth_failed");
  expect(logs.at(-1)?.request_id).toBe(denied.headers.get("x-request-id")!);
  expect(logs.at(-1)?.trace_id).toBe(denied.headers.get("x-trace-id")!);
  expect(JSON.stringify(logs.at(-1))).not.toContain("untrusted-canary");
  expect(calls).toBe(before);
});

test("explicit login, cookie flags, grants and local project/VM reads", async () => {
  const { response, body, cookie } = await login();
  expect(response.status).toBe(200);
  expect(logs.at(-1)?.event).toBe("auth_succeeded");
  expect(response.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict; Path=/; Max-Age=1800");
  expect(body.csrf).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(body.proof).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(JSON.stringify(logs)).not.toContain(body.proof);
  expect((await fetch(base + "api/vms", { headers: { Cookie: cookie } })).status).toBe(401);
  expect((await (await fetch(base + "api/auth/session", { headers: auth(cookie, body.proof) })).json()).csrf).toBe(body.csrf);
  const vms = await (await fetch(base + "api/vms", { headers: auth(cookie, body.proof) })).json();
  expect(vms.projects).toEqual(["private-project"]);
  expect(vms.vms.map((vm: { vm_name: string }) => vm.vm_name)).toEqual(["codex-private-project"]);
  expect((await fetch(base + "api/projects/private-project", { headers: auth(cookie, body.proof) })).status).toBe(200);
  expect((await fetch(base + "api/vms/codex-private-project", { headers: auth(cookie, body.proof) })).status).toBe(200);
  expect((await fetch(base + "api/projects/other-project", { headers: auth(cookie, body.proof) })).status).toBe(404);
  expect((await fetch(base + "api/vms/codex-other-project", { headers: auth(cookie, body.proof) })).status).toBe(404);
  expect(logs.at(-1)?.event).toBe("authz_denied");
});

test("run IDOR is uniform and unknown is read without dispatch", async () => {
  const { cookie, body } = await login();
  const allowed = await fetch(base + "api/runs/run-private-project", { headers: auth(cookie, body.proof) });
  expect((await allowed.json()).status).toBe("unknown");
  const denied = await fetch(base + "api/runs/run-other-project", { headers: auth(cookie, body.proof) });
  const missing = await fetch(base + "api/runs/run-absent", { headers: auth(cookie, body.proof) });
  expect(denied.status).toBe(404);
  expect(missing.status).toBe(404);
  expect((await denied.json()).error.code).toBe((await missing.json()).error.code);
  expect(runtime.getRun("run-private-project")?.status).toBe("unknown");
});

test("cookie from one tab and proof from another cannot be mixed", async () => {
  const first = await login();
  const second = await login();
  expect((await fetch(base + "api/vms", { headers: auth(second.cookie, first.body.proof) })).status).toBe(401);
  expect((await fetch(base + "api/vms", { headers: auth(second.cookie, second.body.proof) })).status).toBe(200);
});

test("logout requires CSRF, unique nonce and revokes only the authenticated session", async () => {
  const { cookie, body } = await login();
  const headers = { ...auth(cookie, body.proof), Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": body.csrf, "X-Request-Nonce": "n".repeat(22) };
  expect((await fetch(base + "api/auth/logout", { method: "POST", headers: { ...headers, "X-CSRF-Token": "bad" }, body: "{}" })).status).toBe(403);
  expect(logs.at(-1)?.event).toBe("csrf_denied");
  const responses = await Promise.all([0, 1].map(() => fetch(base + "api/auth/logout", { method: "POST", headers, body: "{}" })));
  expect(responses.map(row => row.status).sort()).toEqual([200, 401]);
  expect((await fetch(base + "api/auth/session", { headers: { Cookie: cookie } })).status).toBe(401);
});

test("origin, content type, credential failures and methods fail closed", async () => {
  const before = calls;
  expect((await fetch(base + "api/vms", { headers: { Host: "attacker.invalid" } })).status).toBe(403);
  expect((await fetch(base + "api/vms", { headers: { Origin: "http://attacker.invalid" } })).status).toBe(403);
  expect((await fetch(base + "api/vms", { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
  expect((await fetch(base + "api/vms?secret=canary" )).status).toBe(400);
  expect((await fetch(base + "api/vms", { method: "POST", headers: { Origin: origin } })).status).toBe(405);
  expect((await fetch(base + "api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "text/plain" }, body: credential })).status).toBe(400);
  expect((await login("c".repeat(64))).response.status).toBe(401);
  expect(calls).toBe(before);
  expect(JSON.stringify(logs)).not.toMatch(/private-project|other-project|canary|cockpit_session|aaaaaaaa/);
});

test("discovery failure yields 503 without stale inventory", async () => {
  const { cookie, body } = await login();
  fail = true;
  try {
    const response = await fetch(base + "api/vms", { headers: auth(cookie, body.proof) });
    expect(response.status).toBe(503);
    expect((await response.json()).vms).toBeUndefined();
  } finally { fail = false; }
});

test("execution routes require CSRF; arbitrary command routes do not exist", async () => {
  const { cookie, body } = await login();
  for (const path of ["api/runs", "api/exec", "api/vms/codex-private-project/exec"]) {
    const response = await fetch(base + path, { method: "POST", headers: { ...auth(cookie, body.proof), Origin: origin } });
    expect(response.status).toBe(405);
  }
  for (const path of ["api/sessions", "api/sessions/session-private-project/runs", "api/runs/run-private-project/interrupt", "api/approvals/id/decision"]) {
    const response = await fetch(base + path, { method: "POST", body: "{}", headers: { ...auth(cookie, body.proof), Origin: origin, "Content-Type": "application/json" } });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("csrf_denied");
  }
  expect(runtime.getRun("run-private-project")?.status).toBe("unknown");
});

test("brand images: a fixed PNG allowlist served like the page itself; same-origin images only; nothing else under /brand", async () => {
  for (const name of ["emblem", "mark", "lockup", "wordmark", "app-icon", "app-icon-180", "favicon"]) {
    const response = await fetch(`${base}brand/${name}.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG signature
    expect(bytes).toEqual(new Uint8Array(await Bun.file(new URL(`../public/brand/${name}.png`, import.meta.url)).arrayBuffer()));
  }
  const page = await fetch(base);
  const csp = page.headers.get("content-security-policy")!;
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("img-src 'self'");
  expect(csp).not.toMatch(/img-src[^;]*(data:|https?:|\*)/);
  for (const path of ["brand/other.png", "brand/emblem.png.bak", "brand/../src/server.ts", "brand/%2e%2e/src/server.ts", "brand/tokens.json", "brand/"]) {
    expect((await fetch(base + path)).status).toBe(404);
  }
  expect((await fetch(base + "brand/emblem.png?x=1")).status).toBe(400);
  expect((await fetch(base + "brand/emblem.png", { method: "POST", headers: { Origin: origin } })).status).toBe(405);
});

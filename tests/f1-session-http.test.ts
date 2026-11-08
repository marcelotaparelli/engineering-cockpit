import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RequestLog } from "../src/server.ts";
import { LocalSecurity } from "../src/local-security.ts";
import { RuntimeStore } from "../src/runtime-store.ts";
import { EventHub } from "../src/event-hub.ts";
import type { Snapshot } from "../src/model.ts";

/**
 * F1 — sliding session over real HTTP with an injected clock: polling and the live stream never renew a session; only the
 * page's explicit activity signal or a CSRF-verified mutation does; the absolute ceiling, logout and CSRF still hold.
 */
const MIN = 60_000;
const credential = "c".repeat(64);
let clock = Date.parse("2026-11-08T08:00:00.000Z");
const logs: RequestLog[] = [];
const snapshot: Snapshot = { source: "mock", host_verification: "not_verified", observed_at: "2026-11-08T08:00:00.000Z", projects: ["demo"],
  vms: [{ vm_name: "codex-demo", project: "demo", provider: "codex", state: "running", orphaned: false }] };
const dir = await mkdtemp(join(tmpdir(), "cockpit-f1-session-"));
const runtime = new RuntimeStore(join(dir, "runtime.sqlite"));
const security = new LocalSecurity(credential, ["demo"], () => clock);
const server = startServer({ source: "mock", port: 0, security, runtime, hub: new EventHub(), heartbeatMs: 20, log: entry => { logs.push(entry); },
  discovery: { refresh: async () => snapshot } });
const base = server.url.toString();
const origin = base.slice(0, -1);
afterAll(async () => { server.stop(true); runtime.close(); await rm(dir, { recursive: true, force: true }); });

async function login() {
  const response = await fetch(base + "api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ credential }) });
  const body = await response.json() as { csrf: string; proof: string };
  return { response, cookie: response.headers.get("set-cookie")!.split(";")[0]!, ...body };
}
type Login = Awaited<ReturnType<typeof login>>;
const auth = (s: Login, extra: Record<string, string> = {}) => ({ Cookie: s.cookie, "X-Session-Proof": s.proof, ...extra });
const poll = (s: Login) => fetch(base + "api/vms", { headers: auth(s) }).then(r => r.status);
const info = async (s: Login, activity?: string) => {
  const response = await fetch(base + "api/auth/session", { headers: auth(s, activity === undefined ? {} : { "X-Session-Activity": activity }) });
  return { status: response.status, body: response.status === 200 ? await response.json() as { expires_at: string; absolute_expires_at: string; idle_timeout_seconds: number } : null };
};
let nonces = 0;
const mutate = (s: Login, csrf = s.csrf) => fetch(base + "api/sessions", { method: "POST", body: "{}", headers: auth(s, { Origin: origin, "Content-Type": "application/json",
  "X-CSRF-Token": csrf, "X-Request-Nonce": `f1-nonce-${String(++nonces).padStart(16, "0")}` }) });

test("cookie lives up to the 12 h ceiling; session info states both deadlines", async () => {
  const s = await login();
  expect(s.response.headers.get("set-cookie")).toBe(`${s.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
  const { body } = await info(s);
  expect(body!.idle_timeout_seconds).toBe(1800);
  expect(Date.parse(body!.expires_at)).toBe(clock + 30 * MIN);
  expect(Date.parse(body!.absolute_expires_at)).toBe(clock + 12 * 60 * MIN);
});

test("polling only (no operator activity): the session ends after 30 min, even with a request every minute", async () => {
  const s = await login();
  for (let i = 0; i < 29; i++) { clock += MIN; expect(await poll(s)).toBe(200); expect((await info(s)).status).toBe(200); }
  clock += MIN;
  expect(await poll(s)).toBe(401);
  expect(logs.at(-1)?.event).toBe("auth_failed");
});

test("the explicit activity signal renews; any other header value does not", async () => {
  const s = await login();
  clock += 25 * MIN;
  expect((await info(s, "user")).status).toBe(200);
  clock += 25 * MIN; // 50 min after login, 25 after the activity
  expect(await poll(s)).toBe(200);
  expect((await info(s, "yes")).status).toBe(200); // ignored value
  expect((await info(s, "")).status).toBe(200);
  clock += 5 * MIN + 1;
  expect(await poll(s)).toBe(401);
});

test("a CSRF-verified mutation renews; a forged or replayed one does not", async () => {
  const s = await login();
  clock += 20 * MIN;
  expect((await mutate(s)).status).toBe(400); // CSRF passed, body refused: still the page's own script acting
  clock += 20 * MIN;
  expect(await poll(s)).toBe(200);
  const forged = await mutate(s, "forged-csrf");
  expect(forged.status).toBe(403);
  clock += 10 * MIN + 1;
  expect(await poll(s)).toBe(401);
});

test("activity cannot push past the 12 h ceiling", async () => {
  const s = await login();
  const start = clock;
  while (clock < start + 12 * 60 * MIN - 20 * MIN) { clock += 20 * MIN; expect((await info(s, "user")).status).toBe(200); }
  clock = start + 12 * 60 * MIN;
  expect((await info(s, "user")).status).toBe(401);
  expect((await mutate(s)).status).toBe(401);
});

test("logout revokes at once; a cookie the server never minted (fixation) is refused and login always mints a new one", async () => {
  const s = await login();
  clock += 5 * MIN;
  const out = await fetch(base + "api/auth/logout", { method: "POST", body: "{}", headers: auth(s, { Origin: origin, "Content-Type": "application/json",
    "X-CSRF-Token": s.csrf, "X-Request-Nonce": "logout-nonce-000000000001" }) });
  expect(out.status).toBe(200);
  expect((await info(s, "user")).status).toBe(401);
  const planted = "planted_session_value_0123456789";
  expect((await fetch(base + "api/vms", { headers: { Cookie: `cockpit_session=${planted}`, "X-Session-Proof": planted } })).status).toBe(401);
  const fresh = await fetch(base + "api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: `cockpit_session=${planted}` }, body: JSON.stringify({ credential }) });
  expect(fresh.headers.get("set-cookie")).not.toContain(planted);
});

test("the live stream does not renew the session and is closed when the idle deadline passes", async () => {
  const s = await login();
  const response = await fetch(base + "api/events", { headers: auth(s) });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  await reader.read();
  clock += 30 * MIN; // heartbeats (every 20 ms here) keep flowing but are not activity
  const ended = await Promise.race([(async () => { for (;;) { const { done } = await reader.read(); if (done) return true; } })(), Bun.sleep(2000).then(() => false)]);
  expect(ended).toBe(true);
  expect(await poll(s)).toBe(401);
  expect(JSON.stringify(logs)).not.toContain(s.proof);
  expect(JSON.stringify(logs)).not.toContain(credential);
});

test("F1-A over HTTP: 1 250 concurrent mutations (with duplicates) across an epoch boundary — no 429, no double acceptance, critical action still possible, replays refused", async () => {
  const s = await login();
  const post = (path: string, csrf: string, nonce: string) => fetch(base + path, { method: "POST", body: "{}", headers: auth(s, { Origin: origin,
    "Content-Type": "application/json", "X-CSRF-Token": csrf, "X-Request-Nonce": nonce }) });
  const nonces = Array.from({ length: 1200 }, (_, i) => `epoch-nonce-${String(i).padStart(12, "0")}`);
  const burst = [...nonces, ...nonces.slice(0, 50)]; // 50 concurrent duplicates
  const responses = await Promise.all(burst.map(async nonce => {
    const response = await post("api/sessions", s.csrf, nonce);
    const body = await response.json() as { error?: { code: string } };
    return { nonce, status: response.status, code: body.error?.code ?? null };
  }));
  const accepted = responses.filter(r => r.status === 400 && r.code === "invalid_body"); // CSRF passed; the empty body is then refused
  expect(responses.every(r => r.status === 400 || (r.status === 403 && (r.code === "replay_denied" || r.code === "csrf_denied")))).toBe(true);
  expect(responses.some(r => r.status === 429)).toBe(false);
  expect(accepted).toHaveLength(1024); // exactly one full epoch accepted with the original token
  expect(new Set(accepted.map(r => r.nonce)).size).toBe(accepted.length); // no nonce accepted twice
  // The operator's next critical action works after a single token re-read (what the page does on csrf_denied).
  const nextCsrf = (await (await fetch(base + "api/auth/session", { headers: auth(s) })).json() as { csrf: string }).csrf;
  expect(nextCsrf).not.toBe(s.csrf);
  const interrupt = await post("api/runs/run-absent/interrupt", nextCsrf, "critical-interrupt-0000000001");
  expect([404, 409]).toContain(interrupt.status); // CSRF accepted; the (absent) run is what refuses
  // Every request of the closed epoch is refused on replay, accepted ones included.
  const replays = await Promise.all(accepted.slice(0, 200).map(r => post("api/sessions", s.csrf, r.nonce).then(x => x.status)));
  expect(replays.every(status => status === 403)).toBe(true);
  // Revocation is unaffected.
  expect((await post("api/auth/logout", nextCsrf, "logout-after-epoch-000000001")).status).toBe(200);
  expect((await post("api/sessions", nextCsrf, "after-logout-0000000000001")).status).toBe(401);
});

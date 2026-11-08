import { expect, test } from "bun:test";
import { LocalSecurity } from "../src/local-security.ts";

const token = "a".repeat(64);

test("credential failure budget cannot lock out correct local operator", () => {
  let now = 100_000;
  const security = new LocalSecurity(token, ["demo"], () => now);
  for (let i = 0; i < 5; i++) expect(() => security.login("b".repeat(64))).toThrow("authentication_failed");
  expect(() => security.login("b".repeat(64))).toThrow("auth_rate_limited");
  const valid = security.login(token);
  expect(valid.cookie).toBeTruthy();
  now += 60_001;
  expect(() => security.login("b".repeat(64))).toThrow("authentication_failed");
});

test("valid login evicts oldest at capacity and a verified rotation works", () => {
  let now = 100_000;
  const security = new LocalSecurity(token, ["demo"], () => now);
  const sessions = Array.from({ length: 32 }, () => security.login(token));
  const extra = security.login(token);
  expect(() => security.authenticate(`cockpit_session=${sessions[0]!.cookie}`, sessions[0]!.proof)).toThrow("authentication_required");
  const prior = security.authenticate(`cockpit_session=${sessions[1]!.cookie}`, sessions[1]!.proof);
  const rotated = security.login(token, prior);
  expect(() => security.authenticate(`cockpit_session=${sessions[1]!.cookie}`, sessions[1]!.proof)).toThrow("authentication_required");
  expect(security.authenticate(`cockpit_session=${extra.cookie}`, extra.proof)).toBeTruthy();
  expect(security.authenticate(`cockpit_session=${rotated.cookie}`, rotated.proof)).toBeTruthy();
  now += 30 * 60_000;
  expect(() => security.authenticate(`cockpit_session=${rotated.cookie}`, rotated.proof)).toThrow("authentication_required");
});

test("same CSRF nonce is accepted once even under concurrent calls", async () => {
  const security = new LocalSecurity(token, ["demo"]);
  const session = security.login(token);
  expect(() => security.authenticate(`cockpit_session=${session.cookie}`, null)).toThrow("authentication_required");
  const principal = security.authenticate(`cockpit_session=${session.cookie}`, session.proof);
  const nonce = "n".repeat(22);
  const results = await Promise.allSettled([0, 1].map(async () => { security.csrf(principal, session.csrf, nonce); }));
  expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(() => security.csrf(principal, "invalid", "z".repeat(22))).toThrow("csrf_denied");
  expect(() => security.csrf(principal, session.csrf, "z".repeat(22))).not.toThrow();
});

// ---------------------------------------------------------------- F1: sliding session (idle 30 min, absolute 12 h)
const MIN = 60_000;
const authOf = (security: LocalSecurity, session: { cookie: string; proof: string }) => security.authenticate(`cockpit_session=${session.cookie}`, session.proof);

test("F1: authenticated reads alone (polling, SSE re-checks) never extend the session; it ends 30 min after the last activity", () => {
  let now = 1_000_000;
  const security = new LocalSecurity(token, ["demo"], () => now);
  const session = security.login(token);
  for (let minute = 1; minute < 30; minute++) { now += MIN; expect(security.isActive(authOf(security, session))).toBe(true); }
  now += MIN; // exactly 30 min after login, with only reads in between
  expect(() => authOf(security, session)).toThrow("authentication_required");
});

test("F1: operator activity (touch or a CSRF-verified mutation) slides the idle deadline; the 12 h ceiling never moves", () => {
  let now = 1_000_000;
  const start = now;
  const security = new LocalSecurity(token, ["demo"], () => now);
  const session = security.login(token);
  let n = 0;
  const nonce = () => `nonce-${String(++n).padStart(20, "0")}`;
  for (let step = 0; now - start < 12 * 60 * MIN - 25 * MIN; step++) {
    now += 25 * MIN;
    const principal = authOf(security, session);
    if (step % 2 === 0) security.touch(principal); else security.csrf(principal, session.csrf, nonce());
    expect(Date.parse(security.sessionInfo(principal).expires_at)).toBe(Math.min(now + 30 * MIN, start + 12 * 60 * MIN));
  }
  const principal = authOf(security, session);
  expect(security.sessionInfo(principal).absolute_expires_at).toBe(new Date(start + 12 * 60 * MIN).toISOString());
  now = start + 12 * 60 * MIN - 1;
  security.touch(principal);
  expect(security.isActive(principal)).toBe(true);
  now = start + 12 * 60 * MIN;
  expect(security.isActive(principal)).toBe(false);
  expect(() => authOf(security, session)).toThrow("authentication_required");
  // A touch on an ended session cannot revive it.
  security.touch(principal);
  expect(() => authOf(security, session)).toThrow("authentication_required");
});

test("F1: a failed CSRF check is not activity; logout and a credential re-login still revoke a slid session", () => {
  let now = 1_000_000;
  const security = new LocalSecurity(token, ["demo"], () => now);
  const session = security.login(token);
  now += 20 * MIN;
  expect(() => security.csrf(authOf(security, session), "wrong", "x".repeat(22))).toThrow("csrf_denied");
  now += 10 * MIN;
  expect(() => authOf(security, session)).toThrow("authentication_required");

  const kept = security.login(token);
  now += 20 * MIN;
  security.touch(authOf(security, kept));
  now += 20 * MIN;
  const principal = authOf(security, kept); // 40 min after login, alive thanks to the touch
  const rotated = security.login(token, principal);
  expect(() => authOf(security, kept)).toThrow("authentication_required");
  expect(rotated.cookie).not.toBe(kept.cookie);
  const next = authOf(security, rotated);
  security.logout(next);
  expect(security.isActive(next)).toBe(false);
  expect(() => authOf(security, rotated)).toThrow("authentication_required");
});

test("F1: replay protection holds for a whole working day of mutations; limits are validated", () => {
  const security = new LocalSecurity(token, ["demo"]);
  const session = security.login(token);
  const principal = authOf(security, session);
  for (let i = 0; i < 1000; i++) security.csrf(principal, session.csrf, `nonce-${String(i).padStart(20, "0")}`);
  expect(() => security.csrf(principal, session.csrf, `nonce-${String(7).padStart(20, "0")}`)).toThrow("replay_denied");
  expect(() => new LocalSecurity(token, ["demo"], Date.now, { idleMs: 10, maxMs: 5 })).toThrow("invalid_session_limits");
  expect(() => new LocalSecurity(token, ["demo"], Date.now, { idleMs: 0 })).toThrow("invalid_session_limits");
  expect(security.cookieMaxAgeSeconds).toBe(43_200);
});

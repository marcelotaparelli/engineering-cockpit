import { expect, test } from "bun:test";
import { LocalSecurity, MAX_NONCES_PER_EPOCH } from "../src/local-security.ts";

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

test("F1: limits are validated", () => {
  const security = new LocalSecurity(token, ["demo"]);
  expect(() => new LocalSecurity(token, ["demo"], Date.now, { idleMs: 10, maxMs: 5 })).toThrow("invalid_session_limits");
  expect(() => new LocalSecurity(token, ["demo"], Date.now, { idleMs: 0 })).toThrow("invalid_session_limits");
  for (const maxNoncesPerEpoch of [0, -1, 1.5, 70_000]) expect(() => new LocalSecurity(token, ["demo"], Date.now, { maxNoncesPerEpoch })).toThrow("invalid_session_limits");
  expect(security.cookieMaxAgeSeconds).toBe(43_200);
  expect(MAX_NONCES_PER_EPOCH).toBe(1024);
});

// ---------------------------------------------------------------- F1-A: CSRF epochs (replay protection without a capacity dead end)
const nonceOf = (i: number) => `nonce-${String(i).padStart(20, "0")}`;
/** What the page does: on csrf_denied, re-read the token once (GET /api/auth/session) and resend with a fresh nonce. */
function pageMutation(security: LocalSecurity, principal: ReturnType<LocalSecurity["authenticate"]>, held: { csrf: string }, nonce: string, fresh: string): void {
  try { security.csrf(principal, held.csrf, nonce); }
  catch (error) {
    if ((error as Error).message !== "csrf_denied") throw error;
    held.csrf = security.sessionInfo(principal).csrf;
    security.csrf(principal, held.csrf, fresh);
  }
}

test("F1-A: 12 000 mutations in one session never hit a capacity error; memory stays bounded by one epoch", () => {
  const security = new LocalSecurity(token, ["demo"]);
  const session = security.login(token);
  const principal = authOf(security, session);
  const held = { csrf: session.csrf };
  let maxSeen = 0;
  for (let i = 0; i < 12_000; i++) {
    pageMutation(security, principal, held, nonceOf(i), nonceOf(1_000_000 + i));
    maxSeen = Math.max(maxSeen, principal.session.nonces.size);
  }
  expect(maxSeen).toBeLessThan(MAX_NONCES_PER_EPOCH);
  expect(principal.session.epoch).toBe(Math.floor(12_000 / MAX_NONCES_PER_EPOCH));
  // The critical action (interrupt) right after a long run of mutations is accepted.
  expect(() => pageMutation(security, principal, held, nonceOf(2_000_000), nonceOf(2_000_001))).not.toThrow();
});

test("F1-A: every request of a closed epoch is refused on replay (exact headers, or the old token with a new nonce)", () => {
  const security = new LocalSecurity(token, ["demo"], Date.now, { maxNoncesPerEpoch: 8 });
  const session = security.login(token);
  const principal = authOf(security, session);
  const captured: Array<{ csrf: string; nonce: string }> = [];
  const held = { csrf: session.csrf };
  for (let i = 0; i < 40; i++) {
    const before = held.csrf;
    pageMutation(security, principal, held, nonceOf(i), nonceOf(100 + i));
    captured.push({ csrf: before === held.csrf ? before : held.csrf, nonce: before === held.csrf ? nonceOf(i) : nonceOf(100 + i) });
  }
  expect(principal.session.epoch).toBe(5);
  for (const request of captured) {
    let code = "accepted";
    try { security.csrf(principal, request.csrf, request.nonce); } catch (error) { code = (error as Error).message; }
    expect(["replay_denied", "csrf_denied"]).toContain(code); // never accepted twice
  }
  // A closed epoch's token is dead even with a never-seen nonce.
  expect(() => security.csrf(principal, captured[0]!.csrf, nonceOf(999_999))).toThrow("csrf_denied");
});

test("F1-A: within an epoch a nonce is single-use, also under concurrent submission of the same nonce", async () => {
  const security = new LocalSecurity(token, ["demo"], Date.now, { maxNoncesPerEpoch: 4 });
  const session = security.login(token);
  const principal = authOf(security, session);
  const outcomes = await Promise.allSettled(Array.from({ length: 16 }, async () => { security.csrf(principal, session.csrf, nonceOf(1)); }));
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
  // At the epoch boundary: the request that fills the epoch is accepted, the next one with the old token is refused.
  security.csrf(principal, session.csrf, nonceOf(2)); security.csrf(principal, session.csrf, nonceOf(3));
  security.csrf(principal, session.csrf, nonceOf(4)); // fourth nonce: closes epoch 0
  expect(principal.session.epoch).toBe(1);
  expect(() => security.csrf(principal, session.csrf, nonceOf(5))).toThrow("csrf_denied");
  expect(() => security.csrf(principal, session.csrf, nonceOf(4))).toThrow("csrf_denied");
});

test("F1-A: epochs change nothing about revocation, expiry, the 12 h ceiling or sessions of other tabs/logins", () => {
  let now = 1_000_000;
  const start = now;
  const security = new LocalSecurity(token, ["demo"], () => now, { maxNoncesPerEpoch: 2 });
  const a = security.login(token);
  const b = security.login(token);
  const pa = authOf(security, a);
  const pb = authOf(security, b);
  const held = { csrf: a.csrf };
  for (let i = 0; i < 9; i++) pageMutation(security, pa, held, nonceOf(i), nonceOf(50 + i));
  expect(pb.session.csrf).toBe(b.csrf); // another session's token is untouched
  expect(() => security.csrf(pb, b.csrf, nonceOf(0))).not.toThrow(); // and its nonce space is its own
  // A CSRF rotation is not a renewal past the ceiling, and does not survive logout.
  now = start + 12 * 60 * MIN;
  expect(() => authOf(security, a)).toThrow("authentication_required");
  now = start + 60_000;
  const c = security.login(token);
  const pc = authOf(security, c);
  security.logout(pc);
  expect(() => security.csrf(pc, c.csrf, nonceOf(77))).toThrow("authentication_required"); // a revoked session accepts nothing
  expect(() => authOf(security, c)).toThrow("authentication_required");
});

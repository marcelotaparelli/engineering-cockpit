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

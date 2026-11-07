import { expect, test } from "bun:test";
import { assertArchHost, type HostFacts } from "../src/host.ts";
import { readHostVmList } from "../src/adapter.ts";

const env = { COCKPIT_MODE: "host", COCKPIT_HOST_CONFIRMED: "yes" };
const arch: HostFacts = { platform: "linux", osRelease: 'NAME="Arch Linux"\nID=arch\n', knownGuest: false };
test("host gate requires opt-in and exact Arch identity, not ID_LIKE", () => {
  expect(() => assertArchHost({}, arch)).toThrow("host_confirmation_required");
  for (const facts of [
    { ...arch, platform: "darwin" },
    { ...arch, osRelease: 'ID=debian\nID_LIKE=arch\n' },
    { ...arch, osRelease: '' },
  ]) expect(() => assertArchHost(env, facts)).toThrow("arch_host_required");
  expect(() => assertArchHost(env, { ...arch, knownGuest: true })).toThrow("guest_environment_denied");
  expect(() => assertArchHost(env, arch)).not.toThrow();
  expect(() => assertArchHost(env, { ...arch, osRelease: 'ID="arch"\n' })).not.toThrow();
});
test("native adapter fails closed here before reaching any msb process", async () => {
  // No native subprocess in this test, even on an Arch development host.
  const savedMode = process.env.COCKPIT_MODE;
  const savedConfirmation = process.env.COCKPIT_HOST_CONFIRMED;
  delete process.env.COCKPIT_MODE;
  delete process.env.COCKPIT_HOST_CONFIRMED;
  try { await expect(readHostVmList()).rejects.toThrow("host_confirmation_required"); }
  finally {
    if (savedMode === undefined) delete process.env.COCKPIT_MODE; else process.env.COCKPIT_MODE = savedMode;
    if (savedConfirmation === undefined) delete process.env.COCKPIT_HOST_CONFIRMED; else process.env.COCKPIT_HOST_CONFIRMED = savedConfirmation;
  }
});

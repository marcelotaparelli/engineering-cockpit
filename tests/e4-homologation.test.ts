import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { E4_CHECK_IDS, runE4Homologation } from "../src/e4-homologation.ts";

/**
 * E4 drill end to end: real Cockpit child processes in mock mode (SIGKILL mid-stream, restart, a refused second instance,
 * double SIGTERM) and controlled `sleep` orphans. Same code the operator runs with `./scripts/cockpit e4-homologation`.
 */
test.skipIf(process.platform !== "linux")("the recovery drill passes every check and its report carries no secret, content, id or path", async () => {
  const before = (() => { try { return readdirSync(new URL("../.cache/e4-homologation", import.meta.url)); } catch { return []; } })();
  const report = await runE4Homologation({ synthetic: true });
  expect(report.overall).toBe("PASS");
  expect(report.checks.map(check => [check.id, check.status])).toEqual(E4_CHECK_IDS.map(id => [id, "PASS"]));
  expect(report.checks.find(check => check.id === "partial_preserved")!.evidence).toMatchObject({ incomplete: true });
  const text = JSON.stringify(report);
  expect(text).not.toMatch(/[a-f0-9]{64}/); // token
  expect(text).not.toMatch(/slow E4 drill|lento/); // prompt and simulated answer
  expect(text).not.toMatch(/run-[0-9a-f]{8}|ses-[0-9a-f]{8}|e4e4e4e4|127\.0\.0\.1|\/\.cache\//); // ids, URL, paths
  // Its private data directory is removed after a PASS.
  const after = (() => { try { return readdirSync(new URL("../.cache/e4-homologation", import.meta.url)); } catch { return []; } })();
  expect(after).toEqual(before);
}, 60_000);

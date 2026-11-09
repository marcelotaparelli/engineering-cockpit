import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { runHostCheck, type CheckOverrides } from "../src/host-check.ts";
import { mockOutput } from "../src/discovery.ts";
import { SafeError } from "../src/model.ts";

async function fixture(run: (options: CheckOverrides) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "cockpit-host-check-"));
  try {
    await run({ facts: { platform: "linux", osRelease: "ID=arch\n", knownGuest: false },
      env: { COCKPIT_MODE: "host", COCKPIT_HOST_CONFIRMED: "yes", COCKPIT_PROJECTS_BASE: new URL("../fixtures/projects", import.meta.url).pathname },
      readOutput: mockOutput, databasePath: join(root, "host-fixture.sqlite") });
  } finally { await rm(root, { recursive: true, force: true }); }
}
test("host checker on non-Arch skips every msb and database operation", async () => {
  await fixture(async options => {
    let calls = 0;
    const report = await runHostCheck({ ...options, facts: { ...options.facts, osRelease: "ID=debian\n" }, readOutput: async () => { calls++; return "[]"; } });
    expect(report.overall).toBe("NOT_VERIFIED");
    expect(report.checks.find(row => row.id === "host_preflight")?.reason).toBe("arch_host_required");
    expect(report.checks.find(row => row.id === "msb_list")?.status).toBe("NOT_VERIFIED");
    expect(calls).toBe(0);
    expect(existsSync(options.databasePath)).toBe(false);
  });
});
test("synthetic end-to-end host check separates automated PASS from manual NOT_VERIFIED", async () => {
  await fixture(async options => {
    let calls = 0;
    const report = await runHostCheck({ ...options, readOutput: async () => { calls++; return mockOutput(); } });
    expect(report.source).toBe("synthetic");
    expect(report.overall).toBe("PASS");
    expect(report.counts).toEqual({ projects: 3, vms: 3, orphaned_vms: 0 }); // demo, lab, vault (vault: no VM)
    expect(report.checks.filter(row => row.status === "NOT_VERIFIED").map(row => row.id)).toEqual(["browser_visual", "msb_version"]);
    expect(report.checks.some(row => row.status === "FAIL")).toBe(false);
    expect(calls).toBe(1);
    expect(JSON.stringify(report)).not.toContain("codex-demo");
    expect(JSON.stringify(report)).not.toContain(options.databasePath);
  });
});
test("MSB 0.6.8 six-record JSON passes parser, discovery, SQLite reopen and HTTP checks synthetically", async () => {
  await fixture(async options => {
    const projects = join(`${options.databasePath}.projects`);
    const names = ["catus-2026", "sample-02", "sample-03", "sample-04", "sample-05"];
    await mkdir(projects);
    for (const name of names) await mkdir(join(projects, name));
    let calls = 0;
    const output = await Bun.file(new URL("../fixtures/msb/msb-0.6.8-six-records.json", import.meta.url)).text();
    const report = await runHostCheck({ ...options, env: { ...options.env, COCKPIT_PROJECTS_BASE: projects }, readOutput: async () => { calls++; return output; } });
    expect(report.source).toBe("synthetic");
    expect(report.checks.find(row => row.id === "parser")?.status).toBe("PASS");
    expect(report.counts).toEqual({ projects: 5, vms: 6, orphaned_vms: 1 });
    expect(report.overall).toBe("PASS");
    expect(calls).toBe(1);
  });
});
test("observed parse or subprocess failure is FAIL, never NOT_VERIFIED or fabricated empty VMs", async () => {
  await fixture(async options => {
    const parse = await runHostCheck({ ...options, readOutput: async () => "unrecognized real format" });
    expect(parse.overall).toBe("FAIL");
    expect(parse.checks.find(row => row.id === "msb_list")?.status).toBe("PASS");
    expect(parse.checks.find(row => row.id === "parser")?.status).toBe("FAIL");
    expect(parse.counts).toBeNull();
    expect(existsSync(options.databasePath)).toBe(false);
    const subprocess = await runHostCheck({ ...options, readOutput: async () => { throw new SafeError("msb_timeout"); } });
    expect(subprocess.overall).toBe("FAIL");
    expect(subprocess.checks.find(row => row.id === "msb_list")?.reason).toBe("msb_timeout");
    expect(subprocess.checks.find(row => row.id === "parser")?.status).toBe("NOT_VERIFIED");
  });
});

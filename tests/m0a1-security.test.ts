import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertArchHost, hostFacts, type HostFacts } from "../src/host.ts";
import { readHostVmList } from "../src/adapter.ts";
import { runHostCheck, type CheckOverrides } from "../src/host-check.ts";
import { SnapshotStore } from "../src/store.ts";

const consent = { COCKPIT_MODE: "host", COCKPIT_HOST_CONFIRMED: "yes" };
const arch: HostFacts = { platform: "linux", osRelease: "ID=arch\n", knownGuest: false };
async function temporary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "cockpit-m0a1-security-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function changeEnv(values: Record<string, string | undefined>): () => void {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  return () => { for (const [key, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } };
}
async function checkOptions(root: string): Promise<CheckOverrides> {
  const projects = join(root, "projects");
  await mkdir(projects); await mkdir(join(projects, "synthetic"));
  return { facts: arch, env: { ...consent, COCKPIT_PROJECTS_BASE: projects },
    readOutput: async () => '[{"created_at":"2026-10-25T13:54:12Z","image":"node:22","name":"codex-synthetic","status":"Running"}]', databasePath: join(root, "fixture.sqlite") };
}

test("M0a.1 H1: exact consent and Arch identity plus known guest gate", () => {
  for (const env of [{}, { COCKPIT_MODE: "host" }, { COCKPIT_MODE: "mock", COCKPIT_HOST_CONFIRMED: "yes" }, { ...consent, COCKPIT_HOST_CONFIRMED: "YES" }]) {
    expect(() => assertArchHost(env, arch)).toThrow("host_confirmation_required");
  }
  for (const osRelease of ["ID=debian\nID_LIKE=arch\n", "ID=archlinux\n", "ID=arch;synthetic\n", ""]) {
    expect(() => assertArchHost(consent, { ...arch, osRelease })).toThrow("arch_host_required");
  }
  expect(() => assertArchHost(consent, { ...arch, knownGuest: true })).toThrow("guest_environment_denied");
});

test("M0a.1 H1 regression: Firecracker and absent/empty DMI are rejected before native spawn", async () => {
  const restore = changeEnv({ ...consent, container: undefined });
  const originalRead = fs.readFileSync;
  let dmi: string | undefined;
  const read = spyOn(fs, "readFileSync");
  read.mockImplementation(((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(path) === "/etc/os-release") return "ID=arch\n";
    if (String(path) === "/sys/class/dmi/id/product_name") {
      if (dmi === undefined) throw new Error("synthetic_dmi_unavailable");
      return dmi;
    }
    return (originalRead as (...params: unknown[]) => unknown)(path, ...args);
  }) as typeof fs.readFileSync);
  const exists = spyOn(fs, "existsSync").mockReturnValue(false);
  let calls = 0;
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => { calls++; throw new Error("synthetic_spawn_intercepted"); }) as typeof Bun.spawn);
  try {
    for (dmi of ["Firecracker\n", "", " \n", undefined]) {
      expect(hostFacts().knownGuest).toBe(true);
      await expect(readHostVmList()).rejects.toThrow("guest_environment_denied");
      expect(calls).toBe(0);
    }
  } finally { spawn.mockRestore(); exists.mockRestore(); read.mockRestore(); restore(); }
});

test("M0a.1 H2: preflight NOT_VERIFIED and parse FAIL neither write inventory nor disclose input", async () => {
  await temporary(async root => {
    const options = await checkOptions(root);
    let calls = 0;
    const serve = spyOn(Bun, "serve").mockImplementation((() => { throw new Error("unexpected_socket_attempt"); }) as typeof Bun.serve);
    try {
      const denied = await runHostCheck({ ...options, facts: { ...arch, knownGuest: true }, readOutput: async () => { calls++; return "[]"; } });
      expect(denied.source).toBe("synthetic"); expect(denied.overall).toBe("NOT_VERIFIED");
      expect(denied.checks.find(row => row.id === "host_preflight")?.reason).toBe("guest_environment_denied");
      expect(calls).toBe(0); expect(fs.existsSync(options.databasePath)).toBe(false);
      const store = new SnapshotStore(options.databasePath);
      store.replace({ source: "mock", observed_at: "2026-01-01", host_verification: "not_verified", projects: ["prior-synthetic"], vms: [] }); store.close();
      const before = await readFile(options.databasePath);
      const canary = "SYNTHETIC_PARSE_CANARY";
      const failed = await runHostCheck({ ...options, readOutput: async () => canary });
      expect(failed.overall).toBe("FAIL"); expect(failed.counts).toBeNull();
      expect(failed.checks.find(row => row.id === "parser")?.status).toBe("FAIL");
      expect(JSON.stringify(failed)).not.toContain(canary); expect(JSON.stringify(failed)).not.toContain(options.databasePath);
      expect(await readFile(options.databasePath)).toEqual(before);
    } finally { serve.mockRestore(); }
  });
});

test("M0a.1 H2: successful override report remains synthetic with fake HTTP and no inventory leaks", async () => {
  await temporary(async root => {
    const options = await checkOptions(root);
    type Handler = (request: Request, server: { port: number }) => Promise<Response>;
    let handler: Handler | undefined;
    let stopped = false;
    let requests = 0;
    const url = new URL("http://127.0.0.1:43139/");
    const serve = spyOn(Bun, "serve").mockImplementation(((settings: { fetch: Handler }) => {
      handler = settings.fetch; return { port: 43139, url, stop() { stopped = true; } };
    }) as unknown as typeof Bun.serve);
    const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
      requests++;
      if (requests > 30 || !handler || !String(input).startsWith(url.toString())) throw new Error("synthetic_fetch_boundary");
      return handler(new Request(input, { ...init, headers: { host: url.host, ...init?.headers } }), { port: 43139 });
    }) as typeof globalThis.fetch);
    try {
      const report = await runHostCheck(options);
      expect(report.checks.filter(row => row.status === "FAIL")).toEqual([]);
      expect(report.source).toBe("synthetic"); expect(report.overall).toBe("PASS");
      expect(report.counts).toEqual({ projects: 1, vms: 1, orphaned_vms: 0 });
      expect(report.checks.find(row => row.id === "browser_visual")?.status).toBe("NOT_VERIFIED");
      expect(report.checks.find(row => row.id === "msb_version")?.status).toBe("NOT_VERIFIED");
      expect(report.artifact_manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(report)).not.toContain("codex-synthetic");
      expect(JSON.stringify(report)).not.toContain(options.env.COCKPIT_PROJECTS_BASE!);
      expect(stopped).toBe(true); expect(requests).toBe(11); // includes explicit local login before protected reads
    } finally { fetch.mockRestore(); serve.mockRestore(); }
  });
});

test("M0a.1 H3: copied launcher fixes CWD and runtime precedence, refuses runtime mismatch", async () => {
  await temporary(async root => {
    const scripts = join(root, "scripts");
    const bin = join(root, "bin");
    const foreign = join(root, "foreign");
    await mkdir(scripts); await mkdir(bin, { recursive: true }); await mkdir(foreign);
    await writeFile(join(root, ".bun-version"), `${Bun.version}\n`);
    await writeFile(join(scripts, "cockpit"), await readFile(new URL("../scripts/cockpit", import.meta.url)));
    await writeFile(join(bin, "bun"), '#!/bin/sh\nif [ "$1" = --version ]; then printf "%s\\n" "$SYNTHETIC_VERSION"; exit; fi\nprintf "%s\\n" "$PWD" "$1" "$2" "$PATH" "$BUN_INSTALL_CACHE_DIR"\n', { mode: 0o755 });
    for (const version of [Bun.version, "1.4.2", "0.0.0"]) {
      const child = Bun.spawn(["/bin/sh", join(scripts, "cockpit"), "start"], { cwd: foreign,
        env: { PATH: `${bin}:/usr/bin:/bin`, SYNTHETIC_VERSION: version }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (version === Bun.version) {
        expect(status).toBe(0); expect(stdout.split("\n").slice(0, 3)).toEqual([root, "--no-env-file", "src/index.ts"]);
        expect(stdout).toContain(`${bin}:/usr/bin:/bin`); expect(stdout).toContain(join(root, ".cache/bun"));
      } else { expect(status).toBe(1); expect(stderr).toContain("Bun version mismatch"); expect(stdout).toBe(""); }
    }
  });
});

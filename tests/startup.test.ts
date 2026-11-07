import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SnapshotStore } from "../src/store.ts";

test("real launcher starts and reopens SQLite with no global Bun, no /tmp runtime, foreign CWD and no dotenv loading", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  await mkdir(join(root, ".cache"), { recursive: true });
  const copy = await mkdtemp(join(root, ".cache/startup-"));
  try {
    for (const dir of ["src", "public", "fixtures"]) await cp(join(root, dir), join(copy, dir), { recursive: true });
    await mkdir(join(copy, "scripts"));
    await cp(join(root, "scripts/cockpit"), join(copy, "scripts/cockpit"));
    await cp(join(root, ".bun-version"), join(copy, ".bun-version"));
    await mkdir(join(copy, "bin"), { recursive: true });
    await symlink(process.execPath, join(copy, "bin/bun"));
    await writeFile(join(copy, ".bun-version"), `${Bun.version}\n`);
    // If auto-loaded, this invalid PORT prevents startup. No real secret is used.
    await writeFile(join(copy, ".env"), "PORT=invalid-from-dotenv\n");
    for (let restart = 0; restart < 2; restart++) {
      const child = Bun.spawn([join(copy, "scripts/cockpit"), "start"], {
        cwd: join(copy, "fixtures"), env: { PATH: `${join(copy, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, COCKPIT_MODE: "mock", COCKPIT_LOCAL_TOKEN: "a".repeat(64), COCKPIT_ALLOWED_PROJECTS: "demo,lab" },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const reader = child.stdout.getReader();
      const errors = new Response(child.stderr).text();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const first = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("startup_timeout")), 5000); }),
        ]);
        const message = JSON.parse(new TextDecoder().decode(first.value).trim().split("\n")[0]!);
        expect(message.event).toBe("listening");
        expect(message.source).toBe("mock");
        expect(message.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
        expect((await fetch(message.url + "api/vms")).status).toBe(401);
        const login = await fetch(message.url + "api/auth/login", { method: "POST", headers: { Origin: message.url.slice(0, -1), "Content-Type": "application/json" }, body: JSON.stringify({ credential: "a".repeat(64) }) });
        expect(login.status).toBe(200);
        const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
        const proof = (await login.json() as { proof: string }).proof;
        const response = await fetch(message.url + "api/vms", { headers: { Cookie: cookie, "X-Session-Proof": proof } });
        expect(response.status).toBe(200);
        const snapshot = await response.json();
        expect(snapshot.projects).toEqual(["demo", "lab"]);
        expect(snapshot.vms.length).toBe(3);
      } finally {
        if (timeout) clearTimeout(timeout);
        child.kill("SIGTERM");
        const stopTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
        try { await child.exited; } finally { clearTimeout(stopTimer); }
        await reader.cancel(); reader.releaseLock();
      }
      expect(await errors).toBe("");
      expect(child.exitCode).toBe(0);
      const store = new SnapshotStore(join(copy, "data/cockpit-mock.sqlite"));
      try { expect(store.read()?.vms.length).toBe(3); } finally { store.close(); }
    }
  } finally { await rm(copy, { recursive: true, force: true }); }
}, 15000);

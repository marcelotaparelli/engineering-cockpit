import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install, parseEnvFile, repoRoot, restartsAfter, servicePaths, type Runner } from "../src/service.ts";

/**
 * F1 (L3) with real processes, run exactly as the unit runs it: `scripts/cockpit start` from the repository, the settings
 * file as the ONLY configuration (no token in the environment), mock agents, a private data directory. The restart
 * decisions come from the unit's policy (`restartsAfter`, kept equal to the unit by f1-service.test.ts); systemd itself
 * is not involved. Covers: crash + restart, duplicate instance, invalid configuration, orderly stop, resumed use.
 */
const root = repoRoot();
const work = await mkdtemp(join(tmpdir(), "cockpit-f1-proc-"));
const children: Bun.Subprocess[] = [];
afterAll(async () => {
  for (const child of children) { try { child.kill("SIGKILL"); } catch { /* gone */ } await child.exited; }
  await rm(work, { recursive: true, force: true });
});
const noop: Runner = async () => ({ code: 0, stdout: "" });

class Instance {
  readonly child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  stdout = ""; stderr = "";
  readonly url: Promise<string>;
  constructor(env: Record<string, string>) {
    const child = Bun.spawn([join(root, "scripts/cockpit"), "start"], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    this.child = child;
    children.push(child);
    let found!: (url: string) => void;
    this.url = new Promise(resolve => { found = resolve; });
    void (async () => { for await (const chunk of child.stdout) { this.stdout += new TextDecoder().decode(chunk); const m = /"event":"listening","url":"([^"]+)"/.exec(this.stdout); if (m) found(m[1]!); } })();
    void (async () => { for await (const chunk of child.stderr) this.stderr += new TextDecoder().decode(chunk); })();
  }
  listening(): Promise<string> { return Promise.race([this.url, Bun.sleep(10_000).then(() => { throw new Error(`not listening: ${this.stderr}`); })]); }
  async exit(): Promise<{ code: number | null; signal: string | null }> {
    await Promise.race([this.child.exited, Bun.sleep(10_000)]);
    await Bun.sleep(50); // let the pipes drain
    const signal = this.child.signalCode;
    return { code: this.child.exitCode, signal: typeof signal === "string" ? signal : signal === null ? null : String(signal) };
  }
}
class Client {
  cookie = ""; proof = ""; csrf = "";
  constructor(readonly base: string, readonly token: string) {}
  async login(): Promise<number> {
    const response = await fetch(this.base + "api/auth/login", { method: "POST", headers: { Origin: this.base.slice(0, -1), "Content-Type": "application/json" }, body: JSON.stringify({ credential: this.token }) });
    if (response.status === 200) { const body = await response.json() as { proof: string; csrf: string }; this.cookie = response.headers.get("set-cookie")!.split(";")[0]!; this.proof = body.proof; this.csrf = body.csrf; }
    return response.status;
  }
  async get<T>(path: string): Promise<{ status: number; body: T }> {
    const response = await fetch(this.base + path, { headers: { Cookie: this.cookie, "X-Session-Proof": this.proof } });
    return { status: response.status, body: await response.json() as T };
  }
  async post<T>(path: string, body: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    const response = await fetch(this.base + path, { method: "POST", body: JSON.stringify(body), headers: { Cookie: this.cookie, "X-Session-Proof": this.proof, "X-CSRF-Token": this.csrf,
      "X-Request-Nonce": crypto.randomUUID().replaceAll("-", "") + "f1", Origin: this.base.slice(0, -1), "Content-Type": "application/json", ...extra } });
    return { status: response.status, body: await response.json() as T };
  }
}
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string): Promise<T> {
  for (const end = Date.now() + 10_000; ; await Bun.sleep(50)) { const value = await read(); if (done(value)) return value; if (Date.now() > end) throw new Error(label); }
}
type Run = { run_id: string; status: string; reason_code: string | null };
type History = { items: Array<{ kind: string; runId: string | null; text: string | null }> };

test.skipIf(process.platform !== "linux")("service process: duplicate refused (78, no restart), crash restarted without resending, use resumes, orderly stop; token never logged", async () => {
  const configHome = join(work, "config"); await mkdir(configHome, { mode: 0o700 });
  const bin = join(work, "bin"); await mkdir(bin); await symlink(process.execPath, join(bin, "bun"));
  const port = String(20000 + Math.floor(Math.random() * 30000));
  await install({ env: { XDG_CONFIG_HOME: configHome, HOME: configHome, PATH: bin, COCKPIT_MODE: "mock", COCKPIT_ALLOWED_PROJECTS: "demo", PORT: port, COCKPIT_DATA_DIR: join(work, "data") }, run: noop });
  const paths = servicePaths({ XDG_CONFIG_HOME: configHome });
  const token = (await readFile(paths.tokenFile, "utf8")).trim();
  // What systemd passes: the settings file plus the manager's basics. No COCKPIT_LOCAL_TOKEN anywhere.
  const env = { ...parseEnvFile(await readFile(paths.envFile, "utf8")), HOME: configHome, LANG: "C.UTF-8" };
  expect(Object.keys(env)).not.toContain("COCKPIT_LOCAL_TOKEN");
  const all: Instance[] = [];
  const start = () => { const instance = new Instance(env); all.push(instance); return instance; };

  // A: up on the fixed port; the credential from the 0600 file works; a slow simulated answer is streaming.
  const a = start();
  const base = await a.listening();
  expect(base).toBe(`http://127.0.0.1:${port}/`);
  const client = new Client(base, token);
  expect(await client.login()).toBe(200);
  const session = await client.post<{ session_id: string }>("api/sessions", { vm_name: "claude-demo", mode: "new" });
  expect(session.status).toBe(201);
  const sessionId = session.body.session_id;
  const started = await client.post<Run>(`api/sessions/${sessionId}/runs`, { prompt: "slow F1 service drill (simulated agent)" }, { "Idempotency-Key": `f1-${crypto.randomUUID().replaceAll("-", "")}` });
  expect(started.status).toBe(202);
  const runId = started.body.run_id;
  const partial = await until(async () => (await client.get<History>(`api/sessions/${sessionId}/history`)).body.items.find(item => item.runId === runId && item.kind === "agent_message")?.text ?? "",
    text => text.length >= 20, "partial not persisted");

  // B on the same database: refused with 78 → the unit does not restart it; A and its run are untouched.
  const b = start();
  const refused = await b.exit();
  expect(refused.code).toBe(78);
  expect(b.stderr).toContain("runtime_database_in_use");
  expect(restartsAfter(refused)).toBe(false);
  expect((await client.get<Run>(`api/runs/${runId}`)).body.status).toBe("running");

  // Crash of A (SIGKILL) → the unit restarts it.
  a.child.kill("SIGKILL");
  const crashed = await a.exit();
  expect(crashed.signal).toBe("SIGKILL");
  expect(restartsAfter(crashed)).toBe(true);
  const a2 = start();
  expect(await a2.listening()).toBe(base);

  // Browser sessions do not survive a restart (in memory by design): the old cookie is refused, a new login works.
  expect((await client.get("api/dashboard")).status).toBe(401);
  expect(await client.login()).toBe(200);
  // SQLite preserved: same session, the interrupted run is "não confirmado", its streamed text kept, nothing resent.
  const runs = await client.get<{ runs: Run[] }>(`api/sessions/${sessionId}`);
  expect(runs.status).toBe(200);
  expect(runs.body.runs.map(run => run.run_id)).toEqual([runId]);
  expect(runs.body.runs[0]!.status).toBe("unknown");
  const kept = (await client.get<History>(`api/sessions/${sessionId}/history`)).body.items.find(item => item.runId === runId && item.kind === "agent_message")?.text ?? "";
  expect(kept.startsWith(partial)).toBe(true);
  await Bun.sleep(1500);
  expect((await client.get<{ runs: Run[] }>(`api/sessions/${sessionId}`)).body.runs.map(run => `${run.run_id}:${run.status}`)).toEqual([`${runId}:unknown`]);
  // Use resumes: the operator opens a session and sends a new prompt after the restart. (A NEW session: the simulated
  // Claude keeps its sessions in the Cockpit's memory, so `--resume` of a pre-crash session cannot work in mock mode; the
  // real CLI keeps them on the VM's disk.)
  const fresh = await client.post<{ session_id: string }>("api/sessions", { vm_name: "codex-demo", mode: "new" });
  expect(fresh.status).toBe(201);
  const next = await client.post<Run>(`api/sessions/${fresh.body.session_id}/runs`, { prompt: "resposta curta" }, { "Idempotency-Key": `f1-${crypto.randomUUID().replaceAll("-", "")}` });
  expect(next.status).toBe(202);
  expect(await until(async () => (await client.get<Run>(`api/runs/${next.body.run_id}`)).body.status, status => !["prepared", "dispatching", "running"].includes(status), "resumed run did not finish")).toBe("completed");
  // Only the operator's new prompt ran: the pre-crash run is still the only one of its session, still unknown.
  expect((await client.get<{ runs: Run[] }>(`api/sessions/${sessionId}`)).body.runs.map(run => `${run.run_id}:${run.status}`)).toEqual([`${runId}:unknown`]);

  // Orderly stop (systemctl stop = SIGTERM): exit 0, not restarted.
  a2.child.kill("SIGTERM");
  const stopped = await a2.exit();
  expect(stopped).toEqual({ code: 0, signal: null });
  expect(restartsAfter(stopped)).toBe(false);

  // Invalid configuration (credential file readable by others) → refused with 78, never restarted, nothing listening.
  await chmod(paths.tokenFile, 0o644);
  const bad = start();
  const badExit = await bad.exit();
  expect(badExit.code).toBe(78);
  expect(bad.stderr).toContain("local_credential_file_insecure");
  expect(restartsAfter(badExit)).toBe(false);
  await chmod(paths.tokenFile, 0o600);

  for (const instance of all) {
    expect(instance.stdout).not.toContain(token);
    expect(instance.stderr).not.toContain(token);
  }
}, 60_000);

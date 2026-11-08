import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../src/service.ts";

/**
 * The REAL Cockpit (`src/index.ts`) as a child process in MOCK mode: simulated Codex and Claude, no msb, no VM, no quota, its own
 * data directory, credential file and loopback port. Only this child is ever signalled. Restartable on the same data directory and
 * port, which is what a service restart looks like from the browser.
 */
export interface CockpitInstance {
  readonly url: string; readonly origin: string; readonly token: string; readonly dataDir: string; readonly port: number;
  readonly pid: number;
  /** stdout+stderr so far (JSON lines; the credential and prompts must never appear here). */
  logs(): string;
  exitCode(): number | null;
  /** True once the process is gone, however it ended (a signal leaves `exitCode` null). */
  exited(): boolean;
  /** Sends the signal and waits for the exit; returns `{ code, signal }`. */
  stop(signal?: "SIGTERM" | "SIGKILL"): Promise<{ code: number | null; signal: string | null }>;
}
export interface CockpitHarness {
  readonly token: string; readonly dataDir: string; readonly port: number;
  start(extraEnv?: Record<string, string>): Promise<CockpitInstance>;
  /** Stops the running instance (if any) and removes everything created. */
  dispose(): Promise<void>;
}

export async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

export async function cockpitHarness(options: { projects?: string; reservedVms?: string } = {}): Promise<CockpitHarness> {
  const root = await mkdtemp(join(tmpdir(), "cockpit-accept-"));
  const dataDir = join(root, "data");
  const secretDir = join(root, "secret");
  await mkdir(dataDir, { recursive: true });
  await mkdir(secretDir, { mode: 0o700 });
  await chmod(secretDir, 0o700);
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const tokenFile = join(secretDir, "token");
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  const port = await freePort();
  let current: CockpitInstance | null = null;

  async function start(extraEnv: Record<string, string> = {}): Promise<CockpitInstance> {
    if (current && !current.exited()) throw new Error("instance_already_running");
    // Same variables the systemd unit passes: credential from a 0600 file, never in the environment or argv.
    const child = Bun.spawn([process.execPath, "--no-env-file", "src/index.ts"], { cwd: repoRoot(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", COCKPIT_LOCAL_TOKEN_FILE: tokenFile, COCKPIT_ALLOWED_PROJECTS: options.projects ?? "demo,lab",
        PORT: String(port), COCKPIT_DATA_DIR: dataDir, ...(options.reservedVms ? { COCKPIT_RESERVED_VMS: options.reservedVms } : {}), ...extraEnv } });
    let output = "";
    let listening!: () => void; let failed!: () => void;
    const ready = new Promise<boolean>(resolve => { listening = () => resolve(true); failed = () => resolve(false); });
    const drain = async (stream: ReadableStream<Uint8Array>, mark: boolean) => {
      const decoder = new TextDecoder();
      try { for await (const chunk of stream) { const text = decoder.decode(chunk, { stream: true }); output += text; if (mark && output.includes('"event":"listening"')) listening(); } } catch { /* closed */ }
    };
    void drain(child.stdout, true); void drain(child.stderr, false);
    void child.exited.then(() => failed());
    if (!await ready || child.exitCode !== null) { throw new Error(`cockpit_did_not_start: ${output.slice(0, 300)}`); }
    const instance: CockpitInstance = {
      url: `http://127.0.0.1:${port}/`, origin: `http://127.0.0.1:${port}`, token, dataDir, port, pid: child.pid,
      logs: () => output, exitCode: () => child.exitCode, exited: () => child.exitCode !== null || child.signalCode !== null,
      stop: async (signal = "SIGTERM") => {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        const code = await child.exited;
        return { code: child.exitCode ?? code, signal: child.signalCode === null ? null : String(child.signalCode) };
      },
    };
    current = instance;
    return instance;
  }
  return {
    token, dataDir, port, start,
    async dispose() {
      if (current && !current.exited()) await current.stop("SIGTERM").catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Minimal authenticated API client for assertions made outside the page (counters, run lists). */
export class ApiClient {
  #cookie = ""; #proof = ""; #csrf = "";
  constructor(private readonly origin: string, private readonly token: string) {}
  async login(): Promise<void> {
    const response = await fetch(`${this.origin}/api/auth/login`, { method: "POST", headers: { Origin: this.origin, "Content-Type": "application/json" }, body: JSON.stringify({ credential: this.token }) });
    if (response.status !== 200) throw new Error(`login_${response.status}`);
    this.#cookie = (response.headers.get("set-cookie") ?? "").split(";")[0]!;
    const body = await response.json() as { proof: string; csrf: string };
    this.#proof = body.proof; this.#csrf = body.csrf;
  }
  async get<T = any>(path: string): Promise<T> {
    const response = await fetch(`${this.origin}${path}`, { headers: { Cookie: this.#cookie, "X-Session-Proof": this.#proof } });
    if (!response.ok) throw new Error(`get_${path}_${response.status}`);
    return await response.json() as T;
  }
  /** The session's CSRF token is unused here: this client only reads. */
  get csrf(): string { return this.#csrf; }
}

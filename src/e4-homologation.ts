import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SafeError, safeCode } from "./model.ts";
import { RuntimeStore } from "./runtime-store.ts";
import { procProbe, ProcessLedger } from "./process-ledger.ts";
import type { MsbChild, MsbSpawn } from "./msb-transport.ts";
import { assertRuntime } from "./runtime.ts";

/**
 * E4 — recovery drill with REAL Cockpit processes on the operator's host, and nothing else:
 *  - every Cockpit started here is a child of this script, in MOCK mode (simulated agents: no `msb`, no VM, no prompt to a
 *    real model, no quota), on an OS-assigned loopback port, with its own fresh data directory under `.cache/` and its own
 *    random token. The caller's COCKPIT_* settings are ignored; running Cockpits (8787/8788, `data/`) are never contacted,
 *    signalled or opened — the only interaction is the read-only `/proc` scan of the database-ownership check;
 *  - only processes this script spawned are ever signalled.
 * Sequence: start A → stream a slow simulated answer → a second instance on the same data is refused while A keeps its run →
 * SIGKILL A mid-stream → restart → run `unknown` (process_restarted), streamed text kept and marked incomplete, prompt
 * present once, same-key retry replays the same run, reconcile stays unconfirmed with a reason, attention shows it →
 * double SIGTERM exits cleanly once. Then the orphan ledger against controlled `sleep` processes and the real `/proc`.
 * The report holds statuses, codes and counts only: no token, prompt, answer text, ids or paths.
 */
export type E4Status = "PASS" | "FAIL" | "NOT_VERIFIED";
export const E4_CHECK_IDS = ["runtime", "start", "stream_partial", "second_instance_refused", "crash_restart", "partial_preserved", "no_resend",
  "reconcile_conservative", "attention_visible", "orderly_shutdown", "orphan_ledger"] as const;
export type E4CheckId = typeof E4_CHECK_IDS[number];
export interface E4Check { id: E4CheckId; status: E4Status; reason: string | null; evidence?: Record<string, string | number | boolean | null> }
export interface E4Report { milestone: "E4-homologation"; source: "host" | "synthetic"; timestamp: string; overall: E4Status; reason: string | null; checks: E4Check[] }
export interface E4Options { root?: string; synthetic?: boolean; keepOnFailure?: boolean; timeoutsMs?: { start: number; stream: number; exit: number } }

const PROMPT = "slow E4 drill (simulated agent)";

class Cockpit {
  readonly child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  readonly events: Array<Record<string, unknown>> = [];
  stderr = "";
  #listening: Promise<string>;
  constructor(root: string, env: Record<string, string>) {
    const child = Bun.spawn([process.execPath, "--no-env-file", "src/index.ts"], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    this.child = child;
    let resolve!: (url: string) => void; let reject!: (error: Error) => void;
    this.#listening = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    this.#listening.catch(() => {}); // an instance that is expected to be refused never listens
    // Both pipes are drained for the whole life of the child (request logs would otherwise fill the pipe and stall it).
    void (async () => {
      const decoder = new TextDecoder(); let buffer = "";
      for await (const chunk of child.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (this.events.length < 5000) this.events.push({ event: event.event, outcome: event.outcome ?? null, url: event.url ?? null, runtime_ownership: event.runtime_ownership ?? null });
            if (event.event === "listening" && typeof event.url === "string") resolve(event.url);
          } catch { /* not JSON: ignored */ }
        }
      }
      reject(new Error("cockpit_exited_before_listening"));
    })().catch(() => {});
    void (async () => { for await (const chunk of child.stderr) if (this.stderr.length < 16_384) this.stderr += new TextDecoder().decode(chunk); })().catch(() => {});
  }
  listening(timeoutMs: number): Promise<string> {
    return Promise.race([this.#listening, Bun.sleep(timeoutMs).then(() => { throw new SafeError("cockpit_not_listening"); })]);
  }
  async exit(timeoutMs: number): Promise<number | null> {
    return Promise.race([this.child.exited, Bun.sleep(timeoutMs).then(() => null)]);
  }
  async kill(): Promise<void> { try { this.child.kill("SIGKILL"); } catch { /* gone */ } await this.child.exited; }
}

class Client {
  #cookie = ""; #proof = ""; #csrf = "";
  constructor(readonly base: string, private readonly token: string) {}
  async login(): Promise<void> {
    const response = await fetch(this.base + "api/auth/login", { method: "POST", headers: { Origin: this.base.slice(0, -1), "Content-Type": "application/json" }, body: JSON.stringify({ credential: this.token }) });
    if (response.status !== 200) throw new SafeError("login_failed");
    const body = await response.json() as { proof: string; csrf: string };
    this.#cookie = (response.headers.get("set-cookie") ?? "").split(";")[0]!; this.#proof = body.proof; this.#csrf = body.csrf;
  }
  async get<T>(path: string): Promise<{ status: number; body: T }> {
    const response = await fetch(this.base + path, { headers: { Cookie: this.#cookie, "X-Session-Proof": this.#proof } });
    return { status: response.status, body: await response.json() as T };
  }
  async post<T>(path: string, body: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    const response = await fetch(this.base + path, { method: "POST", body: JSON.stringify(body), headers: { Cookie: this.#cookie, "X-Session-Proof": this.#proof,
      "X-CSRF-Token": this.#csrf, "X-Request-Nonce": crypto.randomUUID().replaceAll("-", "") + "e4", Origin: this.base.slice(0, -1), "Content-Type": "application/json", ...extra } });
    return { status: response.status, body: await response.json() as T };
  }
}
type RunBody = { run_id: string; status: string; reason_code: string | null; provider_bound: boolean; replayed?: boolean; reconciliation?: { result: string; reason_code: string } };
type HistoryBody = { items: Array<{ kind: string; runId: string | null; text: string | null; incomplete?: boolean }> };

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number, code: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new SafeError(code);
    await Bun.sleep(50);
  }
}

export async function runE4Homologation(options: E4Options = {}): Promise<E4Report> {
  const report: E4Report = { milestone: "E4-homologation", source: options.synthetic ? "synthetic" : "host", timestamp: new Date().toISOString(),
    overall: "FAIL", reason: null, checks: E4_CHECK_IDS.map(id => ({ id, status: "NOT_VERIFIED", reason: "not_exercised" })) };
  const set = (id: E4CheckId, status: E4Status, reason: string | null = null, evidence?: E4Check["evidence"]) =>
    Object.assign(report.checks.find(check => check.id === id)!, { status, reason, ...(evidence ? { evidence } : {}) });
  const timeouts = options.timeoutsMs ?? { start: 15_000, stream: 10_000, exit: 10_000 };
  const root = realpathSync(options.root ?? fileURLToPath(new URL("..", import.meta.url)));
  const spawned: Cockpit[] = [];
  const controlled: Bun.Subprocess[] = [];
  let dataDir: string | null = null;
  let current: E4CheckId = "runtime";
  try {
    try { assertRuntime(); } catch (error) { set("runtime", "FAIL", safeCode(error)); throw error; }
    if (process.platform !== "linux") { set("runtime", "NOT_VERIFIED", "linux_proc_required"); throw new SafeError("linux_proc_required"); }
    set("runtime", "PASS", null, { platform: process.platform });

    // Fresh, private state; never `data/`.
    const base = join(root, ".cache", "e4-homologation");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    dataDir = join(base, `run-${Date.now()}-${randomBytes(4).toString("hex")}`);
    mkdirSync(dataDir, { mode: 0o700 }); chmodSync(dataDir, 0o700);
    const token = randomBytes(32).toString("hex");
    const inherited: Record<string, string> = {};
    for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "BUN_TMPDIR", "BUN_INSTALL_CACHE_DIR"]) { const value = process.env[name]; if (value) inherited[name] = value; }
    const env = { ...inherited, COCKPIT_MODE: "mock", COCKPIT_LOCAL_TOKEN: token, COCKPIT_ALLOWED_PROJECTS: "demo", COCKPIT_DATA_DIR: dataDir, PORT: "0" };
    const start = () => { const cockpit = new Cockpit(root, env); spawned.push(cockpit); return cockpit; };

    // ---- A: start, simulated slow answer streaming
    current = "start";
    const first = start();
    const url = await first.listening(timeouts.start);
    const ownership = first.events.find(event => event.event === "listening")?.runtime_ownership ?? null;
    if (ownership !== "exclusive") throw new SafeError("runtime_ownership_not_exclusive");
    let client = new Client(url, token);
    await client.login();
    const opened = await client.post<{ session_id: string }>("api/sessions", { vm_name: "claude-demo", mode: "new" });
    if (opened.status !== 201) throw new SafeError(`open_session_${opened.status}`);
    const sessionId = opened.body.session_id;
    const key = `e4-${randomBytes(12).toString("hex")}`;
    const started = await client.post<RunBody>(`api/sessions/${sessionId}/runs`, { prompt: PROMPT }, { "Idempotency-Key": key });
    if (started.status !== 202) throw new SafeError(`start_run_${started.status}`);
    const runId = started.body.run_id;
    set("start", "PASS", null, { runtime_ownership: "exclusive", mode: "mock" });

    current = "stream_partial";
    const partialText = async () => (await client.get<HistoryBody>(`api/sessions/${sessionId}/history`)).body.items.find(item => item.kind === "agent_message" && item.runId === runId)?.text ?? "";
    const early = await poll(partialText, text => text.length >= 20, timeouts.stream, "partial_not_persisted");
    const running = await client.get<RunBody>(`api/runs/${runId}`);
    if (running.body.status !== "running" || !running.body.provider_bound) throw new SafeError(`run_not_running_${running.body.status}`);
    set("stream_partial", "PASS", null, { persisted_chars: early.length });

    // ---- B on the same data directory: refused; A and its run untouched
    current = "second_instance_refused";
    const second = start();
    const code = await second.exit(timeouts.exit);
    if (code === null) throw new SafeError("second_instance_still_running");
    if (code === 0 || !second.stderr.includes("runtime_database_in_use")) throw new SafeError("second_instance_not_refused");
    const still = await client.get<RunBody>(`api/runs/${runId}`);
    if (still.body.status !== "running") throw new SafeError(`first_instance_disturbed_${still.body.status}`);
    set("second_instance_refused", "PASS", null, { exit_code: code, first_instance_run: still.body.status });

    // ---- SIGKILL A mid-stream (no orderly close), restart on the same data
    current = "crash_restart";
    await Bun.sleep(1500); // the simulated answer keeps streaming; trailing writes land meanwhile
    const beforeKill = await partialText();
    await first.kill();
    const restarted = start();
    const url2 = await restarted.listening(timeouts.start);
    client = new Client(url2, token);
    await client.login();
    const after = await client.get<RunBody>(`api/runs/${runId}`);
    if (after.body.status !== "unknown" || after.body.reason_code !== "process_restarted") throw new SafeError(`after_restart_${after.body.status}_${after.body.reason_code ?? "none"}`);
    set("crash_restart", "PASS", null, { status: after.body.status, reason: after.body.reason_code });

    current = "partial_preserved";
    const history = (await client.get<HistoryBody>(`api/sessions/${sessionId}/history`)).body.items;
    const answer = history.find(item => item.kind === "agent_message" && item.runId === runId);
    if (!answer?.text || !answer.text.startsWith(beforeKill) || answer.text.length <= early.length) throw new SafeError("partial_not_preserved");
    if (answer.incomplete !== true) throw new SafeError("partial_not_marked_incomplete");
    set("partial_preserved", "PASS", null, { chars_seen_before_kill: beforeKill.length, chars_after_restart: answer.text.length, incomplete: true });

    current = "no_resend";
    const prompts = history.filter(item => item.kind === "user_message" && item.runId === runId).length;
    const retry = await client.post<RunBody>(`api/sessions/${sessionId}/runs`, { prompt: PROMPT }, { "Idempotency-Key": key });
    const runs = (await client.get<{ runs: unknown[] }>(`api/sessions/${sessionId}`)).body.runs.length;
    if (prompts !== 1 || retry.status !== 200 || retry.body.run_id !== runId || retry.body.replayed !== true || runs !== 1) {
      throw new SafeError(`resend_detected_${prompts}_${retry.status}_${runs}`);
    }
    set("no_resend", "PASS", null, { prompts_in_history: prompts, runs_in_session: runs, retry_replayed: true });

    current = "reconcile_conservative";
    const reconciled = await client.post<RunBody>(`api/runs/${runId}/reconcile`, {});
    if (reconciled.status !== 200 || reconciled.body.status !== "unknown" || reconciled.body.reconciliation?.result !== "unconfirmed") throw new SafeError("reconcile_not_conservative");
    set("reconcile_conservative", "PASS", null, { status: reconciled.body.status, reason: reconciled.body.reconciliation.reason_code });

    current = "attention_visible";
    const dashboard = (await client.get<{ attention: Array<{ kind: string; run_id?: string; reason_code?: string }> }>("api/dashboard")).body;
    const item = dashboard.attention.find(entry => entry.kind === "unknown_run" && entry.run_id === runId);
    if (!item || item.reason_code !== "process_restarted") throw new SafeError("unknown_run_not_visible");
    set("attention_visible", "PASS", null, { kind: "unknown_run", reason: item.reason_code });

    current = "orderly_shutdown";
    // Two signals, as Ctrl+C on a wrapper delivers them. Identical signals sent back to back may be merged by the kernel, so
    // the second one is sent shortly after; whether it arrived before the exit is reported, not required.
    restarted.child.kill("SIGTERM");
    await Bun.sleep(10);
    try { restarted.child.kill("SIGTERM"); } catch { /* already gone */ }
    const exit = await restarted.exit(timeouts.exit);
    if (exit !== 0) throw new SafeError(`shutdown_exit_${exit ?? "timeout"}`);
    set("orderly_shutdown", "PASS", null, { exit_code: 0, second_signal_logged: restarted.events.some(event => event.event === "shutdown.repeated_signal") });

    // ---- process ledger with controlled real processes (separate scratch database; the drill's Cockpit is stopped)
    current = "orphan_ledger";
    const store = new RuntimeStore(join(dataDir, "ledger", "runtime.sqlite"));
    try {
      const gone = Bun.spawn(["true"]); await gone.exited;
      const crashed = new ProcessLedger(store, { self: { pid: gone.pid, startTicks: "1" }, log: () => {} });
      const sleeper: MsbSpawn = () => { const child = Bun.spawn(["sleep", "60"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }); controlled.push(child); return child as unknown as MsbChild; };
      const session = "e4e4e4e4-0000-4000-8000-000000000001";
      const orphan = crashed.track(sleeper)(["msb", "exec", "--stream", "claude-demo", "--", "claude", "-p", "--resume", session], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} });
      if (!procProbe.startTicks(orphan.pid!)) throw new SafeError("proc_identity_unavailable");
      const ledger = new ProcessLedger(store, { log: () => {} });
      const recovered = ledger.recover();
      const blocked = ledger.blocking("claude-demo", session) !== null;
      orphan.kill("SIGKILL"); await orphan.exited;
      const cleared = ledger.orphans().length === 0 && ledger.blocking("claude-demo", session) === null;
      if (recovered.orphans !== 1 || !blocked || !cleared) throw new SafeError("orphan_ledger_mismatch");
      set("orphan_ledger", "PASS", null, { orphans_detected: recovered.orphans, blocked_while_alive: blocked, cleared_after_exit: cleared });
    } finally { store.close(); }

    report.overall = "PASS";
  } catch (error) {
    report.reason = safeCode(error);
    const check = report.checks.find(entry => entry.id === current)!;
    if (check.status !== "FAIL") Object.assign(check, { status: report.reason === "linux_proc_required" ? "NOT_VERIFIED" : "FAIL", reason: report.reason });
    report.overall = report.checks.some(entry => entry.status === "FAIL") ? "FAIL" : "NOT_VERIFIED";
  } finally {
    // Only what this drill spawned; then its private data (kept on failure when asked, for diagnosis).
    for (const cockpit of spawned) if (cockpit.child.exitCode === null) await cockpit.kill();
    for (const child of controlled) { try { child.kill("SIGKILL"); } catch { /* gone */ } await child.exited; }
    if (dataDir && !(report.overall !== "PASS" && options.keepOnFailure)) rmSync(dataDir, { recursive: true, force: true });
  }
  return report;
}

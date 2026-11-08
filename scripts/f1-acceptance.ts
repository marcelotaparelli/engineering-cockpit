/**
 * F1 acceptance runner. One command per tier; each prints what it did and writes an evidence directory.
 *
 *   ./scripts/cockpit f1-accept hermetic [out-dir]        safe anywhere: mock providers, own ports, own data, no msb, no systemd
 *   ./scripts/cockpit f1-accept real-readonly [out-dir]   Arch host: read-only probes of the INSTALLED service (no state change)
 *   ./scripts/cockpit f1-accept real-readonly --with-login [out-dir]
 *                                                         adds ONE login + one dashboard read + one logout (needs COCKPIT_F1_ACCEPT_CONFIRMED=yes)
 *
 * The real tiers that change host state or spend provider quota are NOT here on purpose: they are the existing, separately
 * confirmed `./scripts/cockpit f1-systemd-smoke` (isolated runtime unit; add COCKPIT_SMOKE_ORPHAN_PROOF=yes and
 * COCKPIT_SMOKE_QUOTA_CONFIRMED=yes for the F1-P1 orphan proof). See docs/f1-aceite-automatizado.md.
 *
 * Exit status: 0 = PASS, 1 = FAIL, 2 = NOT_VERIFIED (something could not be exercised; never reported as PASS).
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { findChromium } from "../tests/support/browser.ts";
import { defaultRunner, repoRoot } from "../src/service.ts";
import { runRealReadonly, type RealReport } from "../src/f1-acceptance-real.ts";

const root = repoRoot();
const [tier, ...rest] = process.argv.slice(2);
const withLogin = rest.includes("--with-login");
const positional = rest.filter(arg => !arg.startsWith("--"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

type StepStatus = "PASS" | "FAIL" | "NOT_VERIFIED";
interface Step { id: string; title: string; status: StepStatus; seconds: number; detail: string; log: string }

/** Fixed argv, no shell; a minimal environment so nothing from the caller (COCKPIT_*, tokens) reaches a hermetic child. */
function childEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  for (const key of ["HOME", "LANG", "TMPDIR", "CHROMIUM", "BUN_INSTALL_CACHE_DIR", "BUN_TMPDIR"]) if (process.env[key]) env[key] = process.env[key]!;
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
  return env;
}
async function spawnStep(out: string, id: string, title: string, argv: string[], judge: (code: number, text: string) => { status: StepStatus; detail: string }, extraEnv: Record<string, string | undefined> = {}): Promise<Step> {
  const started = performance.now();
  const child = Bun.spawn(argv, { cwd: root, env: childEnv(extraEnv), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const text = stdout + stderr;
  const log = `${id}.log`;
  await Bun.write(join(out, log), text);
  const verdict = judge(code, text);
  const step: Step = { id, title, status: verdict.status, seconds: Math.round((performance.now() - started) / 100) / 10, detail: verdict.detail, log };
  console.log(`${step.status.padEnd(12)} ${id.padEnd(22)} ${String(step.seconds).padStart(6)} s  ${verdict.detail}`);
  return step;
}
const bun = process.execPath;
const exit0 = (detail: (text: string) => string) => (code: number, text: string) => ({ status: (code === 0 ? "PASS" : "FAIL") as StepStatus, detail: code === 0 ? detail(text) : `exit ${code}: ${text.trim().split("\n").slice(-3).join(" | ").slice(0, 200)}` });
const lastMatch = (text: string, pattern: RegExp) => { const all = [...text.matchAll(pattern)]; return all.length ? all[all.length - 1]![0].trim() : ""; };

async function hermetic(out: string): Promise<number> {
  await mkdir(out, { recursive: true });
  const chromium = findChromium();
  console.log(`F1 acceptance — HERMETIC tier (mock providers; own ports and data; no msb, no systemd, no quota)\nevidence: ${out}\n`);
  const steps: Step[] = [];
  steps.push(await spawnStep(out, "typecheck", "tsc --noEmit (strict)", [bun, "--no-env-file", "run", "typecheck"], exit0(() => "clean")));
  steps.push(await spawnStep(out, "suite", "full deterministic suite (bun test)", [bun, "--no-env-file", "test"], (code, text) => {
    const pass = /^\s*(\d+) pass\s*$/m.exec(text)?.[1]; const fail = /^\s*(\d+) fail\s*$/m.exec(text)?.[1];
    return code === 0 && fail === "0" ? { status: "PASS", detail: `${pass} pass / 0 fail` } : { status: "FAIL", detail: `${pass ?? "?"} pass / ${fail ?? "?"} fail (exit ${code})` };
  }));
  steps.push(await spawnStep(out, "e4-drill", "E4 recovery drill (real Cockpit processes, kill -9, orphans)", [bun, "--no-env-file", "scripts/e4-homologation.ts"], (code, text) => {
    const overall = /"overall":\s*"(\w+)"/.exec(text)?.[1] ?? "?";
    return { status: code === 0 && overall === "PASS" ? "PASS" : code === 2 || overall === "NOT_VERIFIED" ? "NOT_VERIFIED" : "FAIL", detail: `overall ${overall}` };
  }));
  if (!chromium) {
    for (const [id, title] of [["visual-check", "Chromium: Codex flow"], ["brand-visual-check", "Chromium: brand and layouts"], ["f1-visual-check", "Chromium: two tabs, L5, L6"], ["f1-browser-acceptance", "Chromium: Claude flows, restarts, session timers"]] as const) {
      steps.push({ id, title, status: "NOT_VERIFIED", seconds: 0, detail: "no Chromium found (set CHROMIUM=/path); nothing was verified", log: "" });
      console.log(`${"NOT_VERIFIED".padEnd(12)} ${id.padEnd(22)}      -  no Chromium found (set CHROMIUM=/path)`);
    }
  } else {
    const shots = (name: string) => join(out, name);
    const visual = (code: number, text: string) => { const checks = text.split("\n").filter(line => /^(PASS|FAIL) /.test(line)); const failed = checks.filter(line => line.startsWith("FAIL")).length;
      return { status: (code === 0 && failed === 0 && checks.length > 0 ? "PASS" : "FAIL") as StepStatus, detail: `${checks.length - failed}/${checks.length} checks` }; };
    steps.push(await spawnStep(out, "visual-check", "Chromium: Codex flow (login, stream, approval, interrupt, layouts)", [bun, "--no-env-file", "scripts/visual-check.ts", shots("visual-check")], visual, { CHROMIUM: chromium }));
    steps.push(await spawnStep(out, "brand-visual-check", "Chromium: brand and responsive layouts", [bun, "--no-env-file", "scripts/brand-visual-check.ts", shots("brand-visual-check")], visual, { CHROMIUM: chromium }));
    steps.push(await spawnStep(out, "f1-visual-check", "Chromium: two tabs share the session, logout, L5 stream, L6 unsupported", [bun, "--no-env-file", "scripts/f1-visual-check.ts", shots("f1-visual-check")], visual, { CHROMIUM: chromium }));
    steps.push(await spawnStep(out, "f1-browser-acceptance", "Chromium: Claude AskUserQuestion/approval, kill -9 restarts, session timers", [bun, "--no-env-file", "scripts/f1-browser-acceptance.ts", shots("f1-browser-acceptance")], (code, text) => {
      const line = lastMatch(text, /\d+\/\d+ checks/g); return { status: code === 0 ? "PASS" : code === 2 ? "NOT_VERIFIED" : "FAIL", detail: line || `exit ${code}` };
    }, { CHROMIUM: chromium }));
  }
  steps.push(await spawnStep(out, "artifact", "artifact manifest matches the tree", [bun, "--no-env-file", "scripts/artifact.ts", "--check"], exit0(text => text.trim().split("\n").pop() ?? "PASS")));
  return finish("hermetic", out, steps);
}

async function finish(tierName: string, out: string, steps: Step[]): Promise<number> {
  const overall: StepStatus = steps.some(step => step.status === "FAIL") ? "FAIL" : steps.every(step => step.status === "PASS") ? "PASS" : "NOT_VERIFIED";
  const commit = (await new Response(Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { cwd: root, stdout: "pipe", stderr: "ignore" }).stdout).text()).trim();
  const dirty = (await new Response(Bun.spawn(["git", "status", "--porcelain", "--untracked-files=no"], { cwd: root, stdout: "pipe", stderr: "ignore" }).stdout).text()).trim() !== "";
  const report = { milestone: `F1-acceptance-${tierName}`, at: new Date().toISOString(), commit, tree_dirty: dirty, bun: Bun.version, overall, steps };
  await Bun.write(join(out, "report.json"), JSON.stringify(report, null, 2));
  const rows = steps.map(step => `| ${step.id} | ${step.title} | ${step.status} | ${step.seconds} s | ${step.detail} |`).join("\n");
  await Bun.write(join(out, "report.md"), `# F1 acceptance — ${tierName}\n\n- commit: \`${commit}\`${dirty ? " (working tree has uncommitted changes)" : ""}\n- at: ${report.at}\n- overall: **${overall}**\n\n| step | what | result | time | detail |\n| --- | --- | --- | --- | --- |\n${rows}\n`);
  console.log(`\noverall: ${overall}   (commit ${commit}${dirty ? ", tree dirty" : ""})\nreport: ${join(out, "report.md")}`);
  return overall === "PASS" ? 0 : overall === "FAIL" ? 1 : 2;
}

async function realReadonly(out: string): Promise<number> {
  await mkdir(out, { recursive: true });
  console.log(`F1 acceptance — REAL host, READ-ONLY tier${withLogin ? " + one login (confirmed)" : ""}\nIt reads the installed service (systemctl show, /proc, journal, its loopback port). It starts, stops, signals and writes nothing there (only its own report, under .cache/).\n`);
  const report: RealReport = await runRealReadonly({ env: process.env as Record<string, string | undefined>, run: defaultRunner(), root, withLogin });
  await Bun.write(join(out, "report.json"), JSON.stringify({ ...report, commit: (await new Response(Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { cwd: root, stdout: "pipe", stderr: "ignore" }).stdout).text()).trim() }, null, 2));
  for (const check of report.checks) console.log(`${check.status.padEnd(12)} ${check.id.padEnd(28)} ${check.reason ?? ""}`);
  console.log(`\noverall: ${report.overall}; state changed: ${report.state_changed}\nreport: ${join(out, "report.json")}`);
  return report.overall === "PASS" ? 0 : report.overall === "FAIL" ? 1 : 2;
}

if (tier === "hermetic") process.exitCode = await hermetic(resolve(positional[0] ?? join(root, ".cache", "f1-acceptance", `hermetic-${stamp}`)));
else if (tier === "real-readonly") process.exitCode = await realReadonly(resolve(positional[0] ?? join(root, ".cache", "f1-acceptance", `real-readonly-${stamp}`)));
else {
  console.error("uso: ./scripts/cockpit f1-accept hermetic [dir]\n     ./scripts/cockpit f1-accept real-readonly [--with-login] [dir]");
  process.exitCode = 2;
}

/**
 * Real-browser check + screenshots of the PROJECT PICKER against the MOCK Cockpit (simulated agents, no VM, no msb).
 * Only `demo` is granted by configuration; `lab` is discovered and authorized (then revoked) from the page.
 * Dev-only: needs a local Chromium (`CHROMIUM=/path`); not part of `verify`. Same CDP harness as scripts/visual-check.ts.
 *
 *   CHROMIUM=$(command -v chromium) bun scripts/projects-visual-check.ts <out-dir>
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = process.argv[2] ?? "visual-projects";
await mkdir(out, { recursive: true });
const chromium = process.env.CHROMIUM ?? "chromium";
const port = 18000 + Math.floor(Math.random() * 1000);
const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
const base = `http://127.0.0.1:${port}`;
const results: Array<{ check: string; pass: boolean; detail?: string | undefined }> = [];
const check = (name: string, pass: boolean, detail?: string) => { results.push({ check: name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

const dataDir = await mkdtemp(join(tmpdir(), "cockpit-visual-data-"));
const app = Bun.spawn([process.execPath, "--no-env-file", "src/index.ts"], {
  env: { PATH: process.env.PATH!, COCKPIT_LOCAL_TOKEN: token, COCKPIT_ALLOWED_PROJECTS: "demo", PORT: String(port), COCKPIT_DATA_DIR: dataDir }, stdout: "pipe", stderr: "pipe" });
const profile = await mkdtemp(join(tmpdir(), "cockpit-chromium-"));
const browser = Bun.spawn([chromium, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdout: "ignore", stderr: "pipe" });

async function devtoolsUrl(): Promise<string> {
  const reader = browser.stderr.getReader(); let text = "";
  for (;;) { const { value, done } = await reader.read(); if (done) throw new Error("chromium exited"); text += new TextDecoder().decode(value); const m = /DevTools listening on (ws:\/\/\S+)/.exec(text); if (m) { reader.releaseLock(); return m[1]!; } }
}
const browserWs = await devtoolsUrl();
for (let i = 0; i < 50; i++) { try { await fetch(base + "/"); break; } catch { await Bun.sleep(100); } }
const pages = await (await fetch(browserWs.replace("ws://", "http://").replace(/\/devtools\/browser\/.*/, "/json/list"))).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
const ws = new WebSocket(pages.find(p => p.type === "page")!.webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener("open", resolve, { once: true }));
let seq = 0; const waiting = new Map<number, (value: any) => void>();
const consoleErrors: string[] = [];
ws.addEventListener("message", event => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)!(msg); waiting.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(msg.params.exceptionDetails.text);
  if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") consoleErrors.push(msg.params.entry.text);
});
const cdp = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
  const id = ++seq; waiting.set(id, msg => msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)); ws.send(JSON.stringify({ id, method, params }));
});
const js = async <T = unknown>(expression: string): Promise<T> => {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + expression);
  return r.result.value as T;
};
const until = async (expression: string, timeout = 5000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await js<boolean>(expression)) return true; await Bun.sleep(50); } return false; };
const viewport = (width: number, height: number) => cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
const shot = async (name: string) => { const r = await cdp("Page.captureScreenshot", { format: "png" }); await Bun.write(join(out, name), Buffer.from(r.data, "base64")); };
const visible = (selector: string) => `(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; const r = n.getBoundingClientRect(); return getComputedStyle(n).display !== 'none' && r.width > 0 && r.height > 0; })()`;
const noHorizontalOverflow = `document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth`;

const card = (name: string) => `document.querySelector('#catalog .catalog-item[data-project="${name}"]')`;
const text = (expression: string) => js<string>(`(${expression})?.textContent ?? ''`);

try {
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Log.enable");
  await viewport(1440, 900);
  await cdp("Page.navigate", { url: base + "/" });
  await until(visible("#login"));
  await js(`document.getElementById('credential').value = ${JSON.stringify(token)}; document.getElementById('login').requestSubmit(); true`);
  await until(`document.querySelectorAll('#catalog .catalog-item').length === 2`);
  check("1. após o login, a tela inicial é o seletor de projetos", await js<boolean>(visible("#empty")) && !(await js<boolean>(visible("#session-view"))));
  const order = await js<string>(`[...document.querySelectorAll('#catalog .catalog-item')].map(n => n.dataset.project).join(',')`);
  check("1. projetos descobertos listados, autorizado primeiro", order === "demo,lab", `${order} / ${await text("document.getElementById('catalog-notice')")} / ${consoleErrors.join(" | ")}`);
  check("1. demo autorizado pela configuração", (await text(card("demo"))).includes("Autorizado · configuração"));
  check("1. lab descoberto e NÃO autorizado", (await text(card("lab"))).includes("Não autorizado"));
  check("1. lab sem VM: não oferece criar, manda usar o launcher", (await text(card("lab"))).includes("crie pelo launcher"));
  check("1. lab: nenhum agente pode ser aberto antes de autorizar", await js<boolean>(`[...${card("lab")}.querySelectorAll('.pick')].every(b => b.disabled)`));
  check("1. demo: Claude Code e Codex prontos", await js<boolean>(`[...${card("demo")}.querySelectorAll('.pick')].every(b => !b.disabled)`));
  await shot("01-projetos-1440.png");

  await js(`${card("lab")}.querySelector('button.grant').click(); true`);
  await until(`!!${card("lab")}.querySelector('.confirm')`);
  check("2. autorizar pede confirmação explícita", (await text(`${card("lab")}.querySelector('.confirm')`)).includes("Nenhuma VM é criada ou ligada"));
  await shot("02-confirmar-autorizacao-1440.png");
  await js(`${card("lab")}.querySelector('button.confirm-yes').click(); true`);
  await until(`${card("lab")}?.textContent.includes('Autorizado') && !${card("lab")}.textContent.includes('Não autorizado')`);
  check("2. lab autorizado pela interface", (await text(card("lab"))).includes("Revogar acesso"));
  check("2. mensagem de sucesso", (await text(`document.getElementById('catalog-notice')`)).includes("lab autorizado"));
  await shot("03-autorizado-1440.png");

  await js(`${card("demo")}.querySelector('.pick[data-vm="claude-demo"]').click(); true`);
  await until(visible("#session-view"));
  await until(`!document.getElementById('new-session').disabled`);
  await js(`document.getElementById('new-session').click(); true`);
  await until(`document.getElementById('session-select').value.startsWith('s:') && !document.getElementById('prompt').disabled`);
  check("3. escolher Claude Code abre a sessão da VM existente", await js<string>(`document.getElementById('vm-title').textContent`) === "claude-demo");
  await shot("04-sessao-claude-1440.png");

  await js(`document.getElementById('projects-open').click(); true`);
  await until(visible("#empty"));
  check("4. botão Projetos volta ao seletor", await js<boolean>(visible("#catalog")));
  for (const [w, h] of [[1440, 900], [1024, 768], [390, 844]] as const) {
    await viewport(w, h);
    await Bun.sleep(150);
    check(`5. seletor ${w}px sem overflow horizontal`, await js<boolean>(noHorizontalOverflow));
    await shot(`05-projetos-${w}.png`);
  }
  await viewport(1440, 900);
  await js(`${card("lab")}.querySelector('button.revoke').click(); true`);
  await until(`!!${card("lab")}.querySelector('.confirm')`);
  await js(`${card("lab")}.querySelector('button.confirm-yes').click(); true`);
  await until(`${card("lab")}?.textContent.includes('Não autorizado')`);
  check("6. revogar (com confirmação) devolve lab a não autorizado", (await text(card("lab"))).includes("Autorizar"));
  await shot("06-revogado-1440.png");
  check("sem erros de JavaScript/CSP no console", consoleErrors.length === 0, consoleErrors.join(" | "));
} finally {
  ws.close(); browser.kill(); app.kill("SIGTERM"); await app.exited;
  const logs = await new Response(app.stdout).text() + await new Response(app.stderr).text();
  check("7. logs sem credencial", !logs.includes(token));
  check("7. concessão e revogação auditadas no log", logs.includes('"event":"project_grant","action":"grant","project":"lab"') && logs.includes('"event":"project_grant","action":"revoke","project":"lab"'));
  await Bun.write(join(out, "results.json"), JSON.stringify({ at: new Date().toISOString(), mode: "mock", results }, null, 2));
  await rm(profile, { recursive: true, force: true }); await rm(dataDir, { recursive: true, force: true });
  process.exitCode = results.every(r => r.pass) ? 0 : 1;
}

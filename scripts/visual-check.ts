/**
 * Real-browser E2E + screenshots against the MOCK Cockpit (fake App Server, no VM, no msb).
 * Dev-only: needs a local Chromium (`CHROMIUM=/path`); not part of `verify`. Drives Chrome DevTools
 * Protocol over Bun's WebSocket; no npm dependency.
 *
 *   CHROMIUM=$(command -v chromium) bun scripts/visual-check.ts <out-dir>
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = process.argv[2] ?? "visual";
await mkdir(out, { recursive: true });
const chromium = process.env.CHROMIUM ?? "chromium";
const port = 18000 + Math.floor(Math.random() * 1000);
const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
const base = `http://127.0.0.1:${port}`;
const results: Array<{ check: string; pass: boolean; detail?: string | undefined }> = [];
const check = (name: string, pass: boolean, detail?: string) => { results.push({ check: name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

const dataDir = await mkdtemp(join(tmpdir(), "cockpit-visual-data-"));
const app = Bun.spawn([process.execPath, "--no-env-file", "src/index.ts"], {
  env: { PATH: process.env.PATH!, COCKPIT_LOCAL_TOKEN: token, COCKPIT_ALLOWED_PROJECTS: "demo,lab", PORT: String(port), COCKPIT_DATA_DIR: dataDir }, stdout: "pipe", stderr: "pipe" });
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

try {
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Log.enable");
  await viewport(1440, 900);
  await cdp("Page.navigate", { url: base + "/" });
  await until(visible("#login"));
  check("1. login visível antes de autenticar", await js<boolean>(visible("#login")) && !(await js<boolean>(visible("#app"))));
  await shot("01-login-1440.png");
  await js(`document.getElementById('credential').value = ${JSON.stringify(token)}; document.getElementById('login').requestSubmit(); true`);
  await until(`document.querySelectorAll('.agent').length > 0`);
  check("1. formulário de login some após autenticar", !(await js(visible("#login"))) && await js<boolean>(visible("#app")));
  check("2. discovery lista VMs agrupadas por projeto", await js<boolean>(`document.querySelectorAll('.project').length === 2 && document.getElementById('agents').textContent.includes('codex-demo')`));
  check("credencial não aparece no DOM nem no storage", !(await js<boolean>(`document.documentElement.outerHTML.includes(${JSON.stringify(token)}) || JSON.stringify(sessionStorage).includes(${JSON.stringify(token)})`)));
  await until(`document.getElementById('live').textContent === 'ao vivo'`);
  check("SSE conectado (badge ao vivo)", await js<string>(`document.getElementById('live').textContent`) === "ao vivo");

  // 3. select + open session
  await js(`document.querySelector('.agent[data-vm="codex-demo"]').click(); true`);
  await until(visible("#session-view"));
  await until(`!document.getElementById('new-session').disabled`);
  await js(`document.getElementById('new-session').click(); true`);
  await until(`document.getElementById('session-select').value.startsWith('s:') && !document.getElementById('prompt').disabled`);
  check("3. seleção do agente e abertura de sessão", await js<boolean>(`!document.getElementById('prompt').disabled && document.getElementById('vm-title').textContent === 'codex-demo'`));

  // 4. editor, streaming, history
  await js(`document.getElementById('prompt').value = 'Resuma o estado do projeto e liste próximos passos'; document.getElementById('composer').requestSubmit(); true`);
  const streamed = await until(`!!document.querySelector('.msg.live') || document.querySelectorAll('.msg.agent').length > 0`, 4000);
  check("4. streaming em tempo real aparece na conversa", streamed, streamed ? undefined : await js<string>(`document.getElementById("error").textContent + " / " + document.getElementById("conversation").textContent.slice(0, 300) + " / " + document.getElementById("run-status").textContent + " / " + document.getElementById("composer-note").textContent`));
  await until(`document.getElementById('run-status').textContent === 'Concluído'`, 8000);
  check("4. execução concluída e histórico renderizado", await js<boolean>(`document.getElementById('run-status').textContent === 'Concluído' && document.querySelectorAll('.msg.user').length >= 1`));

  // approval flow, visible in the right pane
  await js(`document.getElementById('prompt').value = 'rode os testes (precisa de aprovação)'; document.getElementById('composer').requestSubmit(); true`);
  await until(`document.querySelectorAll('#attention .card').length > 0`, 6000);
  check("Precisa de você mostra a aprovação com contagem", await js<boolean>(`document.getElementById('attention-count').textContent === '1'`));
  // long message overflow stress: a very long unbroken token rendered as text
  await js(`(() => { const li = document.createElement('li'); li.className = 'msg agent'; li.textContent = 'log: ' + 'x'.repeat(3000) + '\\n' + 'linha '.repeat(400); document.getElementById('conversation').append(li); return true; })()`);
  for (const [w, h] of [[1440, 900], [1024, 768], [390, 844]] as const) {
    await viewport(w, h);
    await Bun.sleep(150);
    check(`5. layout ${w}px sem overflow horizontal`, await js<boolean>(noHorizontalOverflow));
    if (w > 900) check(`5. ${w}px mostra as três áreas`, await js<boolean>(`${visible(".pane-agents")} && ${visible(".pane-session")} && ${visible(".pane-inbox")}`));
    else check(`5. ${w}px mostra uma área por vez com abas`, await js<boolean>(`${visible(".tabs")} && ${visible(".pane-session")} && !${visible(".pane-inbox")}`));
    check(`5. ${w}px editor fixo visível no viewport`, await js<boolean>(`(() => { const r = document.getElementById('composer').getBoundingClientRect(); return r.bottom <= window.innerHeight + 1 && r.top > 0; })()`));
    await shot(`02-session-${w}.png`);
  }
  await js(`document.querySelector('.tabs button[data-pane="inbox"]').click(); true`);
  await Bun.sleep(100);
  await shot("03-inbox-390.png");
  await js(`document.querySelector('.tabs button[data-pane="agents"]').click(); true`);
  await Bun.sleep(100);
  await shot("04-agents-390.png");
  await viewport(1440, 900);
  await js(`[...document.querySelectorAll('#attention button')].find(b => b.textContent === 'Aprovar').click(); true`);
  await until(`document.getElementById('run-status').textContent === 'Concluído' && document.getElementById('attention-count').textContent === '0'`, 8000);
  check("aprovação decidida pela inbox e execução concluída", await js<boolean>(`document.getElementById('attention-count').textContent === '0'`));

  // 6. refresh without duplicating
  const runsBefore = await js<number>(`fetch('/api/sessions/' + JSON.parse(sessionStorage.getItem('cockpit_view')).sessionId, { headers: { 'X-Session-Proof': sessionStorage.getItem('cockpit_session_proof') } }).then(r => r.json()).then(d => d.runs.length)`);
  await cdp("Page.reload");
  await until(`document.querySelectorAll('.msg.user').length >= 2`, 6000);
  const runsAfter = await js<number>(`fetch('/api/sessions/' + JSON.parse(sessionStorage.getItem('cockpit_view')).sessionId, { headers: { 'X-Session-Proof': sessionStorage.getItem('cockpit_session_proof') } }).then(r => r.json()).then(d => d.runs.length)`);
  check("6. refresh restaura sessão e histórico sem novo envio", runsBefore === runsAfter && !(await js(visible("#login"))), `runs ${runsBefore} → ${runsAfter}`);
  await shot("05-after-refresh-1440.png");

  // interrupt
  await js(`document.getElementById('prompt').value = 'tarefa lenta para interromper'; document.getElementById('composer').requestSubmit(); true`);
  await until(`!document.getElementById('interrupt').hidden && !document.getElementById('interrupt').disabled`, 5000);
  await js(`document.getElementById('interrupt').click(); true`);
  check("interromper pelo botão", await until(`document.getElementById('run-status').textContent === 'Interrompido'`, 6000));
  check("sem erros de JavaScript/CSP no console", consoleErrors.length === 0, consoleErrors.join(" | "));
} finally {
  ws.close(); browser.kill(); app.kill("SIGTERM"); await app.exited;
  const logs = await new Response(app.stdout).text() + await new Response(app.stderr).text();
  // 7. secrets/content stay out of the server logs
  check("7. logs sem credencial nem prompts", !logs.includes(token) && !logs.includes("Resuma o estado") && !logs.includes("tarefa lenta"));
  await Bun.write(join(out, "results.json"), JSON.stringify({ at: new Date().toISOString(), mode: "mock", results }, null, 2));
  await rm(profile, { recursive: true, force: true }); await rm(dataDir, { recursive: true, force: true });
  process.exitCode = results.every(r => r.pass) ? 0 : 1;
}

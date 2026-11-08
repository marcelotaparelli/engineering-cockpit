/**
 * Real-browser screenshots of the brand/UX pass against the MOCK Cockpit (simulated Claude Code, no VM, no msb, no quota).
 * Covers what scripts/visual-check.ts (Codex flow) does not: brand assets, AskUserQuestion, a tool approval with its full
 * input, live streaming, interruption with an incomplete answer, an unconfirmed run, and desktop/notebook/mobile layouts.
 * Dev-only: needs a local Chromium (`CHROMIUM=/path`); not part of `verify`.
 *
 *   CHROMIUM=$(command -v chromium) bun scripts/brand-visual-check.ts <out-dir>
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = process.argv[2] ?? "visual-brand";
await mkdir(out, { recursive: true });
const chromium = process.env.CHROMIUM ?? "chromium";
const port = 19000 + Math.floor(Math.random() * 1000);
const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
const base = `http://127.0.0.1:${port}`;
const results: Array<{ check: string; pass: boolean; detail?: string | undefined }> = [];
const check = (name: string, pass: boolean, detail?: string) => { results.push({ check: name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

const dataDir = await mkdtemp(join(tmpdir(), "cockpit-brand-data-"));
const app = Bun.spawn([process.execPath, "--no-env-file", "src/index.ts"], {
  env: { PATH: process.env.PATH!, COCKPIT_LOCAL_TOKEN: token, COCKPIT_ALLOWED_PROJECTS: "demo,lab", PORT: String(port), COCKPIT_DATA_DIR: dataDir }, stdout: "pipe", stderr: "pipe" });
const profile = await mkdtemp(join(tmpdir(), "cockpit-brand-chromium-"));
const browser = Bun.spawn([chromium, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--hide-scrollbars", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdout: "ignore", stderr: "pipe" });
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
const until = async (expression: string, timeout = 6000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await js<boolean>(expression)) return true; await Bun.sleep(50); } return false; };
const viewport = (width: number, height: number) => cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
const shot = async (name: string) => { await Bun.sleep(120); const r = await cdp("Page.captureScreenshot", { format: "png" }); await Bun.write(join(out, name), Buffer.from(r.data, "base64")); };
const send = (prompt: string) => js(`document.getElementById('prompt').value = ${JSON.stringify(prompt)}; document.getElementById('composer').requestSubmit(); true`);
const runStatus = `document.getElementById('run-status').textContent`;
const imagesLoaded = `[...document.images].filter(i => i.getBoundingClientRect().width > 0).every(i => i.complete && i.naturalWidth > 0)`;
const noHorizontalOverflow = `document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth`;

try {
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Log.enable");
  // ---- brand: login at three widths
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    await viewport(w, h);
    await cdp("Page.navigate", { url: base + "/" });
    await until(`!document.getElementById('login').hidden`);
    await until(imagesLoaded);
    check(`marca: logos metálicos carregados no login ${w}px`, await js<boolean>(`${imagesLoaded} && document.querySelectorAll('img').length >= 4`));
    check(`login ${w}px sem overflow horizontal`, await js<boolean>(noHorizontalOverflow));
    await shot(`01-login-${w}.png`);
  }
  check("favicon e app icon declarados", await js<boolean>(`!!document.querySelector('link[rel=icon][href="/brand/favicon.png"]') && !!document.querySelector('link[rel=apple-touch-icon]')`));
  await viewport(1440, 900);
  await js(`document.getElementById('credential').value = ${JSON.stringify(token)}; document.getElementById('login').requestSubmit(); true`);
  await until(`document.querySelectorAll('.agent').length > 0 && document.getElementById('live').textContent === 'ao vivo'`);
  await shot("02-empty-workspace-1440.png");

  // ---- Claude session
  await js(`document.querySelector('.agent[data-vm="claude-demo"]').click(); true`);
  await until(`!document.getElementById('new-session').disabled`);
  await js(`document.getElementById('new-session').click(); true`);
  await until(`document.getElementById('session-select').value.startsWith('s:') && !document.getElementById('prompt').disabled`);

  await send("ask me which option");
  check("AskUserQuestion aparece em Precisa de você", await until(`[...document.querySelectorAll('#attention .card')].some(c => c.querySelector('fieldset.question'))`));
  await shot("03-ask-user-question-1440.png");
  await js(`(() => { const card = [...document.querySelectorAll('#attention .card')].find(c => c.querySelector('fieldset.question')); card.querySelector('input[value="B"]').click(); [...card.querySelectorAll('button')].find(b => b.textContent === 'Responder').click(); return true; })()`);
  check("pergunta respondida e execução concluída", await until(`${runStatus} === 'Concluído'`, 8000));

  await send("approve this command");
  check("aprovação de ferramenta com entrada completa", await until(`[...document.querySelectorAll('#attention .card')].some(c => c.textContent.includes('Aprovar comando'))`));
  await js(`(() => { for (const d of document.querySelectorAll('details.detail')) d.open = true; return true; })()`);
  await shot("04-tool-approval-1440.png");
  await js(`[...document.querySelectorAll('#attention button')].find(b => b.textContent === 'Rejeitar').click(); true`);
  check("rejeição pela inbox", await until(`${runStatus} === 'Concluído' && document.getElementById('attention-count').textContent === '0'`, 8000));

  await send("slow essay please");
  // The live node may be replaced by the persisted partial when the history reloads: check the agent text growing while running.
  check("streaming ao vivo", await until(`${runStatus} === 'Executando' && [...document.querySelectorAll('#conversation .msg.agent')].pop()?.textContent.includes('lento lento lento lento')`, 6000));
  await shot("05-streaming-1440.png");
  await until(`!document.getElementById('interrupt').disabled`);
  await js(`document.getElementById('interrupt').click(); true`);
  check("interrompido", await until(`${runStatus} === 'Interrompido'`, 8000));
  check("resposta parcial marcada como incompleta", await until(`!!document.querySelector('.item-incomplete')`, 4000));
  await shot("06-interrupted-incomplete-1440.png");

  await send("crash now");
  check("processo do agente cai: execução não confirmada", await until(`${runStatus} === 'Não confirmado'`, 8000));
  await until(`[...document.querySelectorAll('#attention .card')].some(c => c.textContent.includes('Execução não confirmada'))`, 4000);
  await shot("07-unknown-run-1440.png");

  for (const [w, h, name] of [[1024, 768, "08-session-1024.png"], [390, 844, "09-session-390.png"]] as const) {
    await viewport(w, h);
    check(`${w}px sem overflow horizontal`, await js<boolean>(noHorizontalOverflow));
    await shot(name);
  }
  await js(`document.querySelector('.tabs button[data-pane="inbox"]').click(); true`);
  await shot("10-inbox-390.png");
  await js(`document.querySelector('.tabs button[data-pane="agents"]').click(); true`);
  await shot("11-agents-390.png");
  check("sem erros de JavaScript/CSP no console", consoleErrors.length === 0, consoleErrors.join(" | "));
} finally {
  ws.close(); browser.kill(); app.kill("SIGTERM"); await app.exited;
  await Bun.write(join(out, "results.json"), JSON.stringify({ at: new Date().toISOString(), mode: "mock", results }, null, 2));
  await rm(profile, { recursive: true, force: true }); await rm(dataDir, { recursive: true, force: true });
  process.exitCode = results.every(r => r.pass) ? 0 : 1;
}

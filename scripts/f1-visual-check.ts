/**
 * F1 real-browser checks against the MOCK Cockpit (fake agents, no VM, no msb, no quota). Dev-only, like visual-check.ts:
 *   CHROMIUM=$(command -v chromium) bun scripts/f1-visual-check.ts <out-dir>
 * Covers what happy-dom cannot prove: a real BroadcastChannel between two tabs (session reuse and logout), the live
 * stream surviving a history reload in a real browser (L5), the "Sem suporte" state (L6) and the token-file credential.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = process.argv[2] ?? "visual-f1";
await mkdir(out, { recursive: true });
const chromium = process.env.CHROMIUM ?? "chromium";
const port = 19000 + Math.floor(Math.random() * 1000);
const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
const base = `http://127.0.0.1:${port}`;
const results: Array<{ check: string; pass: boolean; detail?: string | undefined }> = [];
const check = (name: string, pass: boolean, detail?: string) => { results.push({ check: name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

const dataDir = await mkdtemp(join(tmpdir(), "cockpit-f1-visual-data-"));
const secretDir = await mkdtemp(join(tmpdir(), "cockpit-f1-visual-secret-"));
await chmod(secretDir, 0o700);
const tokenFile = join(secretDir, "token");
await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
// The credential comes from the 0600 file, as in the service; `claude-demo` is reserved by configuration for the L6 check.
const app = Bun.spawn([process.execPath, "--no-env-file", "src/index.ts"], {
  env: { PATH: process.env.PATH!, COCKPIT_LOCAL_TOKEN_FILE: tokenFile, COCKPIT_ALLOWED_PROJECTS: "demo,lab", PORT: String(port), COCKPIT_DATA_DIR: dataDir, COCKPIT_RESERVED_VMS: "claude-demo" },
  stdout: "pipe", stderr: "pipe" });
const profile = await mkdtemp(join(tmpdir(), "cockpit-chromium-"));
const browser = Bun.spawn([chromium, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdout: "ignore", stderr: "pipe" });

async function devtoolsUrl(): Promise<string> {
  const reader = browser.stderr.getReader(); let text = "";
  for (;;) { const { value, done } = await reader.read(); if (done) throw new Error("chromium exited"); text += new TextDecoder().decode(value); const m = /DevTools listening on (ws:\/\/\S+)/.exec(text); if (m) { reader.releaseLock(); return m[1]!; } }
}
const browserWs = await devtoolsUrl();
const http = browserWs.replace("ws://", "http://").replace(/\/devtools\/browser\/.*/, "");
for (let i = 0; i < 50; i++) { try { await fetch(base + "/"); break; } catch { await Bun.sleep(100); } }
const consoleErrors: string[] = [];

/** One CDP connection per page (tab). */
async function page(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise(resolve => ws.addEventListener("open", resolve, { once: true }));
  let seq = 0; const waiting = new Map<number, (value: any) => void>();
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
  const shot = async (name: string) => { const r = await cdp("Page.captureScreenshot", { format: "png" }); await Bun.write(join(out, name), Buffer.from(r.data, "base64")); };
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Log.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  return { ws, cdp, js, until, shot };
}
const visible = (selector: string) => `(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; const r = n.getBoundingClientRect(); return getComputedStyle(n).display !== 'none' && r.width > 0 && r.height > 0; })()`;
const pages = await (await fetch(`${http}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
const a = await page(pages.find(p => p.type === "page")!.webSocketDebuggerUrl);
let b: Awaited<ReturnType<typeof page>> | null = null;

try {
  await a.cdp("Page.navigate", { url: base + "/" });
  await a.until(visible("#login"));
  await a.js(`document.getElementById('credential').value = ${JSON.stringify(token)}; document.getElementById('login').requestSubmit(); true`);
  check("login com a credencial do arquivo 0600", await a.until(`document.querySelectorAll('.agent').length > 0`));

  // L6: reserved by configuration and provider without adapter → "Sem suporte", never "Offline · VM parada" for a reason it is not.
  const chip = (vm: string) => `(document.querySelector('.agent[data-vm="${vm}"] .chip') || {}).textContent`;
  check("L6: VM reservada (COCKPIT_RESERVED_VMS) = Sem suporte, com o motivo", await a.js<boolean>(`${chip("claude-demo")} === 'Sem suporte' && document.querySelector('.agent[data-vm="claude-demo"]').textContent.includes('COCKPIT_RESERVED_VMS')`));
  check("L6: provider sem suporte (opencode) = Sem suporte", await a.js<boolean>(`${chip("opencode-lab")} === 'Sem suporte'`));
  await a.shot("01-unsupported-1440.png");

  // L5: a history reload in the middle of a streamed answer keeps what was already shown.
  await a.js(`document.querySelector('.agent[data-vm="codex-demo"]').click(); true`);
  await a.until(`!document.getElementById('new-session').disabled`);
  await a.js(`document.getElementById('new-session').click(); true`);
  await a.until(`document.getElementById('session-select').value.startsWith('s:') && !document.getElementById('prompt').disabled`);
  await a.js(`document.getElementById('prompt').value = 'resposta lenta para testar o stream'; document.getElementById('composer').requestSubmit(); true`);
  await a.until(`(document.querySelector('.msg.live') || {}).textContent?.length > 12`, 8000);
  const before = await a.js<string>(`document.querySelector('.msg.live').textContent`);
  await a.js(`document.querySelector('.agent[data-vm="codex-demo"]').click(); true`); // reload the history while it streams
  await Bun.sleep(400);
  const during = await a.js<string>(`(document.querySelector('.msg.live') || document.querySelector('.msg.agent:last-child') || {}).textContent || ''`);
  check("L5: após recarregar o histórico durante o stream, o texto já exibido continua no início", during.startsWith(before), `antes ${before.length} caracteres, depois ${during.length}`);
  await a.shot("02-stream-after-reload-1440.png");
  await a.until(`document.getElementById('run-status').textContent === 'Concluído'`, 15000);
  const final = await a.js<string>(`[...document.querySelectorAll('.msg.agent')].map(n => n.textContent).join('|')`);
  check("L5: resposta final única e começando pelo texto do stream", final.split("|").filter(text => text.startsWith(before.slice(0, 12))).length === 1, `${final.length} caracteres`);

  // New tab: same origin, real BroadcastChannel → the session is reused without a new login.
  const created = await a.cdp("Target.createTarget", { url: base + "/" });
  await Bun.sleep(300);
  const list = await (await fetch(`${http}/json/list`)).json() as Array<{ id: string; webSocketDebuggerUrl: string }>;
  b = await page(list.find(p => p.id === created.targetId)!.webSocketDebuggerUrl);
  const reused = await b.until(`${visible("#app")} && !${visible("#login")} && document.querySelectorAll('.agent').length > 0`, 5000);
  check("nova aba reaproveita a sessão (sem novo login)", reused);
  check("nova aba usa a mesma prova, só em sessionStorage", await b.js<string>(`sessionStorage.getItem('cockpit_session_proof')`) === await a.js<string>(`sessionStorage.getItem('cockpit_session_proof')`) &&
    !(await b.js<boolean>(`JSON.stringify(localStorage).includes(sessionStorage.getItem('cockpit_session_proof')) || document.cookie.includes(sessionStorage.getItem('cockpit_session_proof'))`)));
  await b.shot("03-new-tab-1440.png");

  // Logout in the new tab revokes the session in both tabs.
  const errorsBeforeLogout = consoleErrors.length;
  check("sem erros de JavaScript/CSP no console até o logout", errorsBeforeLogout === 0, consoleErrors.join(" | "));
  await b.js(`document.getElementById('logout').click(); true`);
  check("logout numa aba devolve a outra aba ao login", await b.until(visible("#login")) && await a.until(visible("#login"), 5000));
  await a.shot("04-other-tab-after-logout-1440.png");
  check("credencial fora do DOM e do storage", !(await a.js<boolean>(`document.documentElement.outerHTML.includes(${JSON.stringify(token)}) || JSON.stringify(sessionStorage).includes(${JSON.stringify(token)}) || JSON.stringify(localStorage).includes(${JSON.stringify(token)})`)));
  // After the logout the other tab learns it from a 401 on purpose: those network entries are expected, nothing else is.
  const after = consoleErrors.slice(errorsBeforeLogout);
  check("após o logout, só as respostas 401 esperadas no console", after.every(text => /status of 401/.test(text)), after.join(" | "));
} finally {
  a.ws.close(); b?.ws.close(); browser.kill(); app.kill("SIGTERM"); await app.exited;
  const logs = await new Response(app.stdout).text() + await new Response(app.stderr).text();
  check("logs sem credencial nem prompts", !logs.includes(token) && !logs.includes("resposta lenta"));
  await Bun.write(join(out, "results.json"), JSON.stringify({ at: new Date().toISOString(), mode: "mock", results }, null, 2));
  await rm(profile, { recursive: true, force: true }); await rm(dataDir, { recursive: true, force: true }); await rm(secretDir, { recursive: true, force: true });
  process.exitCode = results.every(r => r.pass) ? 0 : 1;
}

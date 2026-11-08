/**
 * F1 browser acceptance, HERMETIC: a real Chromium against the REAL Cockpit process in MOCK mode (simulated Codex and Claude).
 * No msb, no VM, no systemd, no provider quota. Every instance has its own loopback port, data directory and 0600 credential
 * file, and only the processes this script started are ever signalled. Running Cockpits (8787, 8788, `data/`) are never contacted.
 *
 *   bun scripts/f1-browser-acceptance.ts <out-dir>      (CHROMIUM=/path to override the browser)
 *
 * Exit 0 = every check passed, 1 = a check failed, 2 = no Chromium (nothing was verified; never reported as PASS).
 * Scenarios (matrix ids in docs/f1-aceite-automatizado.md):
 *   A  Claude: AskUserQuestion answered from the UI; Bash approved; Bash rejected; nothing approves itself      (F1-22, F1-23)
 *   B  Counters and invariants after A: no duplicate prompt, no auto-approval, no unexpected reliability counter  (F1-25)
 *   C  Codex history and a REAL kill -9 / SIGTERM of the Cockpit: relogin, history once, unknown + reconcile,
 *      nothing resent                                                                                              (F1-08, F1-21, F1-24)
 *   D  Session lifecycle with REAL timers (30 s idle / 50 s ceiling instead of 30 min / 12 h): the banner, renewal by
 *      real input and by a mutation, no renewal by polling, expiry back to the login, the ceiling holding under
 *      continuous activity                                                                                          (F1-01..F1-05)
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { findChromium, launchBrowser, type Page } from "../tests/support/browser.ts";
import { ApiClient, cockpitHarness, type CockpitInstance } from "../tests/support/cockpit-process.ts";
import { startMockCockpit } from "../tests/support/mock-cockpit.ts";

const out = process.argv[2] ?? "f1-browser-acceptance";
/** Optional subset for development: letters of the scenarios to run (default `ACD`; A includes B). */
const only = process.argv[3] ?? "ACD";
await mkdir(out, { recursive: true });
const chromium = findChromium();
interface Result { id: string; matrix: string; check: string; pass: boolean; detail?: string | undefined }
const results: Result[] = [];
/** One reporter per scenario: scenarios run concurrently, so the numbering cannot depend on shared state. */
const reporter = (prefix: string) => { let n = 0; return (matrix: string, name: string, pass: boolean, detail?: string) => {
  const id = `${prefix}${++n}`;
  results.push({ id, matrix, check: name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} [${id}/${matrix}] ${name}${detail ? " — " + detail : ""}`);
}; };
if (!chromium) {
  console.log("NOT_VERIFIED: nenhum Chromium encontrado (defina CHROMIUM=/caminho). Nada foi verificado.");
  await Bun.write(join(out, "results.json"), JSON.stringify({ at: new Date().toISOString(), mode: "hermetic-browser", overall: "NOT_VERIFIED", reason: "chromium_not_found", results: [] }, null, 2));
  process.exit(2);
}

// ------------------------------------------------------------------------------------------------ page helpers
async function login(page: Page, origin: string, token: string) {
  await page.goto(origin + "/");
  await page.until(`!document.getElementById('login').hidden`, 8000);
  await page.js(`document.getElementById('credential').value = ${JSON.stringify(token)}; document.getElementById('login').requestSubmit(); true`);
  return page.until(`document.querySelectorAll('.agent').length > 0`, 8000);
}
async function openVm(page: Page, vm: string) {
  await page.click(`.agent[data-vm="${vm}"]`);
  await page.until(`!document.getElementById('new-session').disabled`, 8000);
}
async function newSession(page: Page) {
  // The selector may already hold an older session: wait for a DIFFERENT one, never for "any".
  const before = await page.js<string>(`document.getElementById('session-select').value`);
  await page.click("#new-session");
  return page.until(`(() => { const v = document.getElementById('session-select').value; return v.startsWith('s:') && v !== ${JSON.stringify(before)} && !document.getElementById('prompt').disabled; })()`, 8000);
}
async function send(page: Page, prompt: string) {
  await page.js(`document.getElementById('prompt').value = ${JSON.stringify(prompt)}; document.getElementById('composer').requestSubmit(); true`);
}
const runStatus = (page: Page) => page.text("#run-status");
const buttonExists = (label: string) => `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled)`;
const conversation = (page: Page) => page.js<string>(`document.getElementById('conversation').textContent`);
const sessionId = (page: Page) => page.js<string>(`JSON.parse(sessionStorage.getItem('cockpit_view')).sessionId`);

// ------------------------------------------------------------------------------------------------ A + B: Claude flows, counters
async function scenarioAB(browser: Awaited<ReturnType<typeof launchBrowser>>) {
  const harness = await cockpitHarness();
  const cockpit = await harness.start();
  const page = await browser.newPage();
  const check = reporter("A");
  try {
    check("F1-10", "login com a credencial lida de arquivo 0600", await login(page, cockpit.origin, cockpit.token));
    await openVm(page, "claude-demo");
    check("F1-22", "VM Claude (claude-demo) é operável: sessão nova disponível", await newSession(page));

    // AskUserQuestion: the card shows the question and the options, nothing is pre-selected, an empty answer is refused locally.
    await send(page, "ask me a question");
    const asked = await page.until(buttonExists("Responder"), 10_000);
    check("F1-23", "AskUserQuestion aparece como pergunta com as opções, sem nenhuma pré-selecionada", asked &&
      await page.js<boolean>(`(() => { const radios = [...document.querySelectorAll('input[type=radio]')]; return radios.length === 2 && radios.every(r => !r.checked) && document.body.textContent.includes('A ou B?'); })()`));
    await page.shot("01-ask-card.png");
    await page.clickByText("button", "Responder");
    await Bun.sleep(400);
    check("F1-23", "responder sem escolher é recusado na interface e a pergunta continua aberta", await page.js<boolean>(buttonExists("Responder")));
    await page.js(`(() => { const radio = [...document.querySelectorAll('input[type=radio]')].find(r => r.value === 'A'); radio.click(); return true; })()`);
    await page.clickByText("button", "Responder");
    check("F1-23", "a resposta volta ao agente: o turno conclui com a resposta do agente", await page.until(`document.getElementById('run-status').textContent === 'Concluído'`, 10_000) && (await conversation(page)).includes("obrigado"));
    await page.shot("02-ask-answered.png");

    // Bash approval: nothing approves itself while the card is open; then approve; then a second one is rejected.
    await send(page, "approve the probe");
    check("F1-22", "ferramenta Bash pede aprovação com o comando visível", await page.until(buttonExists("Aprovar"), 10_000) && (await page.js<string>(`document.body.textContent`)).includes("touch /tmp/e2-approval-probe"));
    await Bun.sleep(1500);
    check("F1-25", "sem ação do operador a aprovação não se resolve sozinha (1,5 s depois ainda aberta e o run aguardando)", await page.js<boolean>(buttonExists("Aprovar")) && (await runStatus(page)) === "Aguardando aprovação");
    await page.clickByText("button", "Aprovar");
    check("F1-22", "aprovar: o turno conclui e o agente informa a execução", await page.until(`document.getElementById('run-status').textContent === 'Concluído'`, 10_000) && (await conversation(page)).includes("executado"));
    await send(page, "approve again");
    await page.until(buttonExists("Rejeitar"), 10_000);
    await page.clickByText("button", "Rejeitar");
    check("F1-22", "rejeitar: o turno conclui e o agente informa a recusa", await page.until(`document.getElementById('run-status').textContent === 'Concluído'`, 10_000) && (await conversation(page)).includes("recusado"));
    await page.shot("03-approve-reject.png");

    // Interrupt on the Claude VM, then the session still works (the operator's manual E3 step, now repeatable).
    await send(page, "slow answer to interrupt");
    await page.until(`!document.getElementById('interrupt').hidden && !document.getElementById('interrupt').disabled`, 8000);
    await page.click("#interrupt");
    check("F1-24", "interromper o Claude pelo botão", await page.until(`document.getElementById('run-status').textContent === 'Interrompido'`, 10_000));
    await send(page, "remember Segurança");
    await page.until(`document.getElementById('run-status').textContent === 'Concluído'`, 10_000);
    await send(page, "recall what I asked you to remember");
    await page.until(`document.getElementById('run-status').textContent === 'Concluído' && document.getElementById('conversation').textContent.includes('Segurança')`, 10_000);
    check("F1-22", "a sessão continua depois da interrupção e preserva o contexto", (await conversation(page)).includes("Segurança"));

    // B: counters and invariants from the API, outside the page.
    const api = new ApiClient(cockpit.origin, cockpit.token);
    await api.login();
    // The UI shows "Concluído" a moment before the service finishes its bookkeeping of the dispatch (`runs_dispatched` is counted when the
    // provider write returns, which for a very fast simulated turn can be after the turn's own end). Wait for the counters to settle
    // instead of sampling once; a counter that never settles is still a FAIL below.
    const prompts = 6; // ask, approve, approve again, slow, remember, recall
    let dashboard = await api.get("/api/dashboard");
    for (let tries = 0; tries < 50 && (dashboard.reliability.active_runs !== 0 || dashboard.reliability.runs_dispatched < prompts); tries++) { await Bun.sleep(100); dashboard = await api.get("/api/dashboard"); }
    const reliability = dashboard.reliability as Record<string, number | string>;
    check("F1-25", `runs enviados = prompts digitados (${prompts}), nenhum duplicado`, reliability.runs_dispatched === prompts, `runs_dispatched=${reliability.runs_dispatched}`);
    for (const counter of ["dispatch_failed", "dispatch_unconfirmed", "dispatch_blocked_orphan", "transport_lost", "provider_session_lost", "vm_stopped", "approval_delivery_unconfirmed", "transitions_rejected", "transcript_write_failed", "reconcile_unconfirmed"]) {
      check("F1-25", `contador de confiabilidade ${counter} = 0`, reliability[counter] === 0, `${counter}=${reliability[counter]}`);
    }
    check("F1-25", "sem processo órfão, sem run ativo e sem aprovação pendente ao fim", reliability.orphan_processes === 0 && reliability.active_runs === 0 && reliability.approval_handles === 0 && dashboard.attention.length === 0,
      `orphans=${reliability.orphan_processes} active=${reliability.active_runs} handles=${reliability.approval_handles} attention=${dashboard.attention.length}`);
    const sid = await sessionId(page);
    const history = await api.get(`/api/sessions/${sid}/history`);
    const users = (history.items as Array<{ kind: string }>).filter(item => item.kind === "user_message").length;
    check("F1-25", "o histórico persistido tem cada prompt exatamente uma vez", users === prompts, `user_message=${users}`);
    check("F1-28", "sem erros de JavaScript/CSP no console durante os fluxos", page.consoleErrors.length === 0, page.consoleErrors.join(" | "));
  } finally {
    page.close();
    await cockpit.stop("SIGTERM");
    const logs = cockpit.logs();
    check("F1-28", "logs do Cockpit sem credencial nem prompts", !logs.includes(cockpit.token) && !logs.includes("approve the probe") && !logs.includes("Segurança"));
    await harness.dispose();
  }
}

// ------------------------------------------------------------------------------------------------ C: real restarts of the Cockpit
/**
 * The mock Codex keeps its threads in the memory of the process (the real App Server keeps them in the VM), so a Codex thread's
 * history cannot survive a mock restart; the Cockpit's own persisted transcript (Claude, E3.1) and the run store (both providers) can.
 * Claude therefore proves history persistence; both providers prove the `unknown` run, the conservative reconcile and no resend.
 */
async function scenarioC(browser: Awaited<ReturnType<typeof launchBrowser>>) {
  const check = reporter("C");
  const harness = await cockpitHarness();
  let cockpit: CockpitInstance = await harness.start();
  const logs: string[] = [];
  const page = await browser.newPage();
  const PROMPT_DONE = "Resuma o estado do projeto para a homologação";
  const SLOW_CLAUDE = "slow answer that will be cut by the crash";
  const SLOW_CODEX = "resposta lenta para testar a queda";
  const restart = async (signal: "SIGKILL" | "SIGTERM") => {
    const ended = await cockpit.stop(signal);
    logs.push(cockpit.logs());
    cockpit = await harness.start();
    return ended;
  };
  const relogin = async (vm: string) => {
    const back = await page.until(`!document.getElementById('login').hidden`, 20_000);
    await login(page, cockpit.origin, cockpit.token);
    await openVm(page, vm);
    return back;
  };
  const selectSession = (id: string) => page.js(`(() => { const s = document.getElementById('session-select'); s.value = 's:${id}'; s.dispatchEvent(new Event('change')); return true; })()`);
  const api = () => new ApiClient(cockpit.origin, cockpit.token);
  try {
    // ---- Claude: persisted history, a run cut by kill -9, reconcile, no resend
    await login(page, cockpit.origin, cockpit.token);
    await openVm(page, "claude-demo");
    await newSession(page);
    const claudeSession = await sessionId(page);
    await send(page, PROMPT_DONE);
    check("F1-22", "Claude: execução concluída", await page.until(`document.getElementById('run-status').textContent === 'Concluído'`, 10_000));
    await send(page, SLOW_CLAUDE);
    check("F1-24", "Claude: resposta parcial já chegou à tela quando o Cockpit cai", await page.until(`(document.querySelector('.msg.live') || {}).textContent?.length > 12`, 10_000));
    await page.shot("01-claude-streaming-before-kill.png");
    await new Promise(resolve => setTimeout(resolve, 1500)); // the partial answer is persisted every 1 s
    const killed = await restart("SIGKILL");
    check("F1-08", "kill -9 do Cockpit (processo real): encerrado por sinal", killed.signal === "SIGKILL", `signal=${killed.signal}`);
    check("F1-08", "a aba aberta volta ao login (sessões revogadas no reinício)", await relogin("claude-demo"));
    check("F1-08", "a credencial não fica na tela nem no storage após a queda", !(await page.js<boolean>(`document.documentElement.outerHTML.includes(${JSON.stringify(cockpit.token)}) || JSON.stringify(sessionStorage).includes(${JSON.stringify(cockpit.token)})`)));
    await selectSession(claudeSession);
    await page.until(`document.getElementById('run-status').textContent === 'Não confirmado'`, 10_000);
    const text = await conversation(page);
    check("F1-22", "histórico persistido: o prompt anterior à queda aparece uma única vez", text.split(PROMPT_DONE).length === 2, `ocorrências=${text.split(PROMPT_DONE).length - 1}`);
    check("F1-24", "o run cortado pela queda aparece como Não confirmado, com a resposta parcial preservada e marcada", await runStatus(page) === "Não confirmado" && /incomplet|parcial/i.test(text), text.slice(-160));
    await page.shot("02-claude-unknown-after-kill.png");
    await page.click("#reconcile");
    await page.until(`!document.getElementById('error').hidden`, 8000);
    const message = await page.text("#error");
    check("F1-24", "reconciliar sem evidência explica por que continua não confirmado", /continua não confirmado|sem evidência/.test(message), message.slice(0, 140));
    check("F1-24", "o estado não foi promovido a sucesso nem falha sem evidência", await runStatus(page) === "Não confirmado");
    const detail = await (async () => { const client = api(); await client.login(); return client.get(`/api/sessions/${claudeSession}`); })();
    check("F1-24", "nada foi reenviado: a sessão tem exatamente 2 runs (concluído + cortado)", (detail.runs as unknown[]).length === 2, `runs=${(detail.runs as unknown[]).length}`);

    // ---- Codex: a run cut by kill -9 is unknown after the restart and is surfaced in the inbox
    await openVm(page, "codex-demo");
    await newSession(page);
    const codexSession = await sessionId(page);
    await send(page, SLOW_CODEX);
    await page.until(`(document.querySelector('.msg.live') || {}).textContent?.length > 12`, 10_000);
    await restart("SIGKILL");
    await relogin("codex-demo");
    const client = api(); await client.login();
    const codexDetail = await client.get(`/api/sessions/${codexSession}`);
    const run = (codexDetail.runs as Array<{ status: string }>)[0];
    check("F1-24", "Codex: o run em voo na queda é unknown depois do reinício", (codexDetail.runs as unknown[]).length === 1 && run?.status === "unknown", `status=${run?.status}`);
    const dashboard = await client.get("/api/dashboard");
    check("F1-24", "Codex: o run Não confirmado aparece em 'Precisa de você' e a interface o mostra", (dashboard.attention as Array<{ kind: string }>).some(item => item.kind === "unknown_run") && await page.until(`document.getElementById('attention-count').textContent !== '0'`, 8000));
    await page.shot("03-codex-unknown-inbox.png");
    await page.clickByText("#attention button", "Abrir e reconciliar");
    check("F1-24", "Codex: 'Abrir e reconciliar' abre a sessão do run com o botão Reconciliar", await page.until(`document.getElementById('run-status').textContent === 'Não confirmado' && !document.getElementById('reconcile').hidden`, 10_000));

    // ---- Orderly stop
    const stopped = await cockpit.stop("SIGTERM");
    logs.push(cockpit.logs());
    check("F1-13", "SIGTERM: saída ordenada com status 0", stopped.code === 0, `code=${stopped.code}`);
    check("F1-28", "logs de todas as vidas do Cockpit sem credencial nem prompts", logs.every(log => !log.includes(cockpit.token) && ![PROMPT_DONE, SLOW_CLAUDE, SLOW_CODEX].some(prompt => log.includes(prompt))));
  } finally {
    page.close();
    await harness.dispose();
  }
}

// ------------------------------------------------------------------------------------------------ D: session lifecycle with real timers
const IDLE_MS = 30_000;
const CEILING_MS = 50_000;
/** Two browsers: cookies are not scoped by port, so two Cockpits on 127.0.0.1 would overwrite each other's session cookie in one profile. */
async function scenarioD(idleBrowser: Awaited<ReturnType<typeof launchBrowser>>, ceilingBrowser: Awaited<ReturnType<typeof launchBrowser>>) {
  const check = reporter("D");
  type Line = [string, string, boolean, string | undefined];
  const idleLines: Line[] = []; const ceilingLines: Line[] = [];
  const noteIdle = (matrix: string, name: string, pass: boolean, detail?: string) => idleLines.push([matrix, name, pass, detail]);
  const noteCeiling = (matrix: string, name: string, pass: boolean, detail?: string) => ceilingLines.push([matrix, name, pass, detail]);
  // Phase 1: idle expiry, renewal by real input, polling never renews.
  const idle = await startMockCockpit({ limits: { idleMs: IDLE_MS, maxMs: 600_000 } });
  const ceiling = await startMockCockpit({ limits: { idleMs: IDLE_MS, maxMs: CEILING_MS } });
  const one = await idleBrowser.newPage();
  const two = await ceilingBrowser.newPage();
  try {
    const sessionInfo = (page: Page, activity = false) => page.js<{ expires_at: string; absolute_expires_at: string; idle_timeout_seconds: number } | { status: number }>(
      `fetch('/api/auth/session', { headers: { 'X-Session-Proof': sessionStorage.getItem('cockpit_session_proof') ${activity ? ", 'X-Session-Activity': 'user'" : ""} }, credentials: 'same-origin' }).then(async r => r.ok ? r.json() : { status: r.status })`);
    // The two phases are independent (own server, own page): run them side by side.
    await Promise.all([(async () => {
    const started = Date.now();
    await login(one, idle.origin, idle.token);
    // The login itself counts as a server renewal and the page reports input at most once a minute. A reload reuses the session
    // (proof in sessionStorage) with a fresh page whose first real input is reported at once: that is the path under test.
    await one.goto(idle.origin + "/");
    await one.until(`document.querySelectorAll('.agent').length > 0`, 8000);
    const firstInfo = await sessionInfo(one) as { expires_at: string };
    noteIdle("F1-04", "o aviso de expiração aparece (faltam menos de 5 min) e diz que é por inatividade",
      await one.until(`!document.getElementById('session').hidden && document.getElementById('session').textContent.includes('sem atividade')`, 5000), await one.text("#session"));
    await one.shot("01-banner-idle.png");
    // Polling alone: a read without the activity header leaves the deadline where it was.
    await Bun.sleep(3000);
    const polled = await sessionInfo(one) as { expires_at: string };
    noteIdle("F1-03", "leituras (polling) não deslocam o prazo de ociosidade", polled.expires_at === firstInfo.expires_at, `${firstInfo.expires_at} → ${polled.expires_at}`);
    // Real input (CDP key event): the page reports activity and the deadline moves forward.
    await one.press("Shift");
    const renewed = await one.until(`true`, 100) && await (async () => {
      for (const end = Date.now() + 5000; Date.now() < end; await Bun.sleep(100)) { const info = await sessionInfo(one) as { expires_at: string }; if (Date.parse(info.expires_at) > Date.parse(firstInfo.expires_at) + 1000) return info.expires_at; }
      return null;
    })();
    noteIdle("F1-03", "entrada real do operador (tecla) renova o prazo no servidor", renewed !== null, `${firstInfo.expires_at} → ${renewed}`);
    const renewedAt = Date.parse(String(renewed ?? firstInfo.expires_at));
    // From here the page gets no input: it must end at the renewed deadline, not at the original one, and not later.
    const wait = renewedAt - Date.now();
    const survivedOriginal = Date.now() > Date.parse(firstInfo.expires_at) ? true : (await Bun.sleep(Math.max(0, Date.parse(firstInfo.expires_at) - Date.now() + 1500)), await one.visible("#app"));
    noteIdle("F1-03", "depois do prazo original, a sessão renovada continua ativa", survivedOriginal);
    const gone = await one.until(`!document.getElementById('login').hidden`, Math.max(0, wait) + 25_000);
    const endedAt = Date.now();
    noteIdle("F1-01", "sem atividade, a aba volta ao login depois do prazo renovado (a página consulta a cada 15 s)", gone, `${Math.round((endedAt - started) / 1000)} s após o login; prazo ${Math.round((renewedAt - started) / 1000)} s`);
    noteIdle("F1-05", "ao expirar, o stream ao vivo fecha e o painel é limpo", await one.js<boolean>(`document.getElementById('app').hidden && document.getElementById('agents').children.length === 0 && document.getElementById('live').hidden`));
    await one.shot("02-expired-to-login.png");
    noteIdle("F1-05", "o servidor recusa a prova expirada (401)", await one.js<number>(`fetch('/api/dashboard', { credentials: 'same-origin' }).then(r => r.status)`) === 401);

    })(), (async () => {
    const ceilingStart = Date.now();
    await login(two, ceiling.origin, ceiling.token);
    await openVm(two, "codex-demo");
    let sessions = 0;
    let stillLoggedIn = true;
    // A mutation every ~8 s (opening a new session is a CSRF-verified POST = operator activity) and a key press each time.
    while (Date.now() - ceilingStart < CEILING_MS - 6000 && stillLoggedIn) {
      await two.press("Shift");
      if (await two.js<boolean>(`!document.getElementById('new-session').disabled`)) { await two.click("#new-session"); sessions++; }
      await Bun.sleep(8000);
      stillLoggedIn = await two.visible("#app");
    }
    noteCeiling("F1-02", `com atividade contínua (${sessions} mutações e teclas) a sessão segue ativa antes do teto`, stillLoggedIn && sessions >= 3, `${Math.round((Date.now() - ceilingStart) / 1000)} s`);
    await two.until(`true`, 10);
    const info = await sessionInfo(two) as { absolute_expires_at: string; expires_at: string };
    noteCeiling("F1-02", "o prazo efetivo nunca passa do teto absoluto", Date.parse(info.expires_at) <= Date.parse(info.absolute_expires_at) + 1, `${info.expires_at} ≤ ${info.absolute_expires_at}`);
    await two.shot("03-near-ceiling.png");
    const reachedLogin = await two.until(`!document.getElementById('login').hidden`, CEILING_MS - (Date.now() - ceilingStart) + 25_000);
    const total = Date.now() - ceilingStart;
    noteCeiling("F1-02", "no teto absoluto a sessão termina mesmo com atividade recente, e a página volta ao login", reachedLogin && total >= CEILING_MS - 2000, `${Math.round(total / 1000)} s (teto ${CEILING_MS / 1000} s)`);
    })()]);
    ceilingLines.push(["F1-28", "sem erros de JavaScript inesperados (só 401 de sessão encerrada)", [...one.consoleErrors, ...two.consoleErrors].every(text => /status of 401|Failed to load resource/.test(text)), [...one.consoleErrors, ...two.consoleErrors].join(" | ").slice(0, 200)]);
  } finally {
    one.close(); two.close(); await idle.stop(); await ceiling.stop();
    for (const [matrix, name, pass, detail] of [...idleLines, ...ceilingLines]) check(matrix, name, pass, detail);
    if (!idleLines.length && !ceilingLines.length) check("F1-05", "cenário D não chegou a nenhuma verificação", false);
  }
}

// ------------------------------------------------------------------------------------------------ run
const browser = await launchBrowser(chromium, out);
const browserForD = await launchBrowser(chromium, out);
const browserForD2 = await launchBrowser(chromium, out);
let crashed: string | null = null;
try {
  // D (≈ 1.5 min of real time) runs in its own browser, alongside A+B and C (separate Cockpits, ports and data directories).
  // allSettled: a failing scenario never abandons the others half way (their Cockpits, pages and servers are closed by their own finally).
  const settled = await Promise.allSettled([
    (async () => { if (only.includes("A")) await scenarioAB(browser); if (only.includes("C")) await scenarioC(browser); })(),
    only.includes("D") ? scenarioD(browserForD, browserForD2) : Promise.resolve(),
  ]);
  for (const outcome of settled) if (outcome.status === "rejected") {
    crashed = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    results.push({ id: `X${results.length + 1}`, matrix: "-", check: "o cenário terminou sem exceção", pass: false, detail: crashed });
    console.log(`FAIL [X] exceção: ${crashed}`);
  }
} finally {
  await browser.close(); await browserForD.close(); await browserForD2.close();
  const pass = results.length > 0 && results.every(r => r.pass);
  await Bun.write(join(out, "results.json"), JSON.stringify({ at: new Date().toISOString(), mode: "hermetic-browser", chromium: chromium.split("/").pop(),
    overall: pass ? "PASS" : "FAIL", passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length, results }, null, 2));
  console.log(`\n${results.filter(r => r.pass).length}/${results.length} checks`);
  // Explicit exit: nothing must keep a finished acceptance run alive (a server of an abandoned scenario, a timer).
  process.exit(pass ? 0 : 1);
}

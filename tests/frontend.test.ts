import { expect, test } from "bun:test";
import { Window } from "happy-dom";

const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
const javascript = await Bun.file(new URL("../public/app.js", import.meta.url)).text();
/** The page's own brand images (static markup). Data must never add any image beyond these. */
const staticImages = (html.match(/<img\b/g) ?? []).length;

const vm = { vm_name: "codex-demo", project: "demo", provider: "codex", vm_state: "running", orphaned: false, runnable: true, state: "idle",
  next_step: "Abrir sessão e enviar prompt", session_id: "ses-1", run_id: null, last_activity: null, sessions: 1 };
const dashboard = (overrides: Record<string, unknown> = {}) => ({ source: "mock", host_verification: "not_verified", observed_at: new Date().toISOString(),
  discovery_error: null, projects: ["demo"], vms: [vm], cursor: 7, attention: [],
  sessions: [{ session_id: "ses-1", project: "demo", vm_name: "codex-demo", thread_id: "thread-0001", last_activity: new Date().toISOString(), latest_run: null, state: "idle" }],
  counts: { working: 0, blocked: 0, awaiting_approval: 0, completed: 0, failed: 0, unknown: 0, interrupted: 0 }, ...overrides });
const sessionData = (runs: unknown[] = [], approvals: unknown[] = []) => ({ session: { session_id: "ses-1" }, runs, approvals });

type Call = { method: string; path: string; headers: Record<string, string>; body: string | null };
type Reply = { status: number; body: unknown } | Error | "stream";
type Router = (call: Call) => Reply | undefined;

async function withUi(router: Router, run: (ui: Window, calls: Call[], push: (block: string) => void) => Promise<void>, storage: Record<string, string> = { cockpit_session_proof: "synthetic" }) {
  const ui = new Window({ url: "http://127.0.0.1:12345/", settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  const calls: Call[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  ui.fetch = (async (input: unknown, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const call = { method: init.method ?? "GET", path: String(input), headers: init.headers ?? {}, body: init.body ?? null };
    if (call.path === "/api/auth/session") return new ui.Response(JSON.stringify({ csrf: "csrf-synthetic" }), { status: 200, headers: { "Content-Type": "application/json" } });
    calls.push(call);
    const reply = router(call);
    if (reply === undefined) throw new Error(`unexpected_fetch ${call.method} ${call.path}`);
    if (reply instanceof Error) throw reply;
    if (reply === "stream") {
      const body = new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } });
      return { ok: true, status: 200, body } as unknown as Response;
    }
    return new ui.Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }) as typeof ui.fetch;
  ui.document.write(html);
  for (const [key, value] of Object.entries(storage)) ui.sessionStorage.setItem(key, value);
  const push = (block: string) => { for (const controller of streams) controller.enqueue(new TextEncoder().encode(block)); };
  try { ui.eval(javascript); await settle(); await run(ui, calls, push); }
  finally { await ui.happyDOM.close(); }
}
const click = (node: unknown) => { (node as { click(): void }).click(); };
async function settle(ms = 40) { await Bun.sleep(ms); }
const defaultRouter = (extra: Router = () => undefined): Router => call => {
  const custom = extra(call);
  if (custom !== undefined) return custom;
  if (call.path === "/api/dashboard") return { status: 200, body: dashboard() };
  if (call.path === "/api/events") return "stream";
  if (call.path === "/api/vms/codex-demo/threads") return { status: 200, body: { vm_name: "codex-demo", threads: [{ id: "thread-0001", status: "idle", updatedAt: null, sessionId: "ses-1" }, { id: "thread-9999-external", status: "idle", updatedAt: null, sessionId: null }] } };
  if (call.path === "/api/sessions/ses-1") return { status: 200, body: sessionData() };
  if (call.path === "/api/sessions/ses-1/history") return { status: 200, body: { items: [{ id: "i1", runId: "t1", kind: "user_message", text: "olá", status: null, command: null, exitCode: null, files: [] }, { id: "i2", runId: "t1", kind: "agent_message", text: "resposta anterior", status: null, command: null, exitCode: null, files: [] }], runs: [], next_cursor: null } };
  return undefined;
};

test("without a session proof the login form is shown and nothing is fetched", async () => {
  await withUi(() => undefined, async (ui, calls) => {
    expect(ui.document.getElementById("login")!.hasAttribute("hidden")).toBe(false);
    expect(ui.document.getElementById("app")!.hasAttribute("hidden")).toBe(true);
    expect(calls).toEqual([]);
  }, {});
});

test("dashboard shows agents, simulation label, and opens the live stream at the dashboard cursor", async () => {
  await withUi(defaultRouter(), async (ui, calls) => {
    expect(ui.document.getElementById("source")!.textContent).toContain("SIMULAÇÃO");
    expect(ui.document.getElementById("agents")!.textContent).toContain("codex-demo");
    expect(ui.document.getElementById("agents")!.textContent).toContain("Ocioso");
    expect(ui.document.getElementById("attention")!.textContent).toContain("Nada pendente");
    const stream = calls.find(call => call.path === "/api/events")!;
    expect(stream.headers["Last-Event-ID"]).toBe("7");
    expect(stream.headers["X-Session-Proof"]).toBe("synthetic");
    expect(ui.document.getElementById("live")!.textContent).toBe("ao vivo");
  });
});

test("select VM → history → send prompt once with CSRF and idempotency key → live delta renders", async () => {
  let posted: Call | null = null;
  const router = defaultRouter(call => {
    if (call.method === "POST" && call.path === "/api/sessions/ses-1/runs") {
      posted = call;
      return { status: 202, body: { run_id: "run-1", session_id: "ses-1", status: "prepared", provider_bound: false, reason_code: null, metrics: { inputTokens: null }, replayed: false } };
    }
    return undefined;
  });
  await withUi(router, async (ui, calls, push) => {
    click(ui.document.querySelector(".agent"));
    await settle();
    expect(ui.document.getElementById("conversation")!.textContent).toContain("resposta anterior");
    const select = ui.document.getElementById("session-select") as unknown as HTMLSelectElement;
    expect([...select.options].map(option => option.textContent).join("|")).toContain("Retomar thread Codex thread-9");
    (ui.document.getElementById("prompt") as unknown as HTMLTextAreaElement).value = "implemente o login";
    ui.document.getElementById("composer")!.dispatchEvent(new ui.Event("submit", { cancelable: true }));
    await settle();
    expect(posted).not.toBeNull();
    expect(posted!.headers["X-CSRF-Token"]).toBe("csrf-synthetic");
    expect(posted!.headers["Idempotency-Key"]).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.parse(posted!.body!)).toEqual({ prompt: "implemente o login" });
    expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
    expect(ui.sessionStorage.getItem("cockpit_pending_send")).toBeNull();
    push(`event: live\ndata: ${JSON.stringify({ kind: "delta", session_id: "ses-1", run_id: "run-1", itemId: "a1", delta: "Trabalhando " })}\n\n`);
    push(`event: live\ndata: ${JSON.stringify({ kind: "delta", session_id: "ses-1", run_id: "run-1", itemId: "a1", delta: "<b>nisso</b>" })}\n\n`);
    await settle();
    const live = ui.document.querySelector(".msg.live")!;
    expect(live.textContent).toBe("Trabalhando <b>nisso</b>");
    expect(ui.document.querySelectorAll("b").length).toBe(0);
  });
});

test("an unconfirmed send survives refresh and is confirmed with the SAME key (no duplicate)", async () => {
  const keys: string[] = [];
  let fail = true;
  const router = defaultRouter(call => {
    if (call.method === "POST" && call.path === "/api/sessions/ses-1/runs") {
      keys.push(call.headers["Idempotency-Key"]!);
      if (fail) return new Error("offline");
      return { status: 200, body: { run_id: "run-1", session_id: "ses-1", status: "running", provider_bound: true, reason_code: null, metrics: {}, replayed: true } };
    }
    return undefined;
  });
  let storage: Record<string, string> = {};
  await withUi(router, async ui => {
    click(ui.document.querySelector(".agent"));
    await settle();
    (ui.document.getElementById("prompt") as unknown as HTMLTextAreaElement).value = "tarefa importante";
    ui.document.getElementById("composer")!.dispatchEvent(new ui.Event("submit", { cancelable: true }));
    await settle();
    expect(ui.document.getElementById("pending")!.hasAttribute("hidden")).toBe(false);
    storage = { cockpit_session_proof: "synthetic", cockpit_pending_send: ui.sessionStorage.getItem("cockpit_pending_send")!, cockpit_view: ui.sessionStorage.getItem("cockpit_view")! };
  });
  fail = false;
  // "Refresh": a new page with the same tab storage restores the view and offers confirmation; nothing is auto-resent.
  await withUi(router, async ui => {
    await settle();
    expect(keys).toHaveLength(1);
    expect(ui.document.getElementById("pending")!.hasAttribute("hidden")).toBe(false);
    click(ui.document.getElementById("pending-confirm"));
    await settle();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]!);
    expect(ui.document.getElementById("pending")!.hasAttribute("hidden")).toBe(true);
  }, storage);
});

test("attention inbox decides an approval with its exact expected version; content is text only", async () => {
  const markup = '<img src=x onerror="globalThis.compromised=true">';
  const approval = { kind: "approval", approval_id: "apr-1", run_id: "run-1", session_id: "ses-1", project: "demo", vm_name: "codex-demo", version: 3,
    action_type: "command", created_at: new Date().toISOString(), summary: { actionType: "command", command: `rm -rf build ${markup}`, cwd: "/workspace", reason: "limpar", files: [], itemId: null } };
  let decision: Call | null = null;
  const router = defaultRouter(call => {
    if (call.path === "/api/dashboard") return { status: 200, body: dashboard({ attention: decision ? [] : [approval], counts: { working: 0, awaiting_approval: 1, completed: 0, failed: 0, unknown: 0, interrupted: 0 } }) };
    if (call.method === "POST" && call.path === "/api/approvals/apr-1/decision") { decision = call; return { status: 200, body: { status: "approved", version: 4 } }; }
    return undefined;
  });
  await withUi(router, async ui => {
    expect(ui.document.getElementById("attention-count")!.textContent).toBe("1");
    expect(ui.document.getElementById("attention")!.textContent).toContain(markup);
    expect(ui.document.querySelectorAll("img").length).toBe(staticImages);
    click([...ui.document.querySelectorAll("#attention button")].find(node => node.textContent === "Aprovar"));
    await settle();
    expect(JSON.parse(decision!.body!)).toEqual({ decision: "approve", expected_version: 3 });
    expect(decision!.headers["X-CSRF-Token"]).toBe("csrf-synthetic");
    expect(ui.document.getElementById("attention")!.textContent).toContain("Nada pendente");
  });
});

test("unknown run shows reconcile, never a resend; interrupt targets the active run", async () => {
  const unknownRun = { run_id: "run-u", session_id: "ses-1", status: "unknown", provider_bound: true, reason_code: "transport_lost", metrics: { inputTokens: null, durationMs: null } };
  const router = defaultRouter(call => {
    if (call.path === "/api/sessions/ses-1") return { status: 200, body: sessionData([unknownRun]) };
    return undefined;
  });
  await withUi(router, async (ui, calls) => {
    click(ui.document.querySelector(".agent"));
    await settle();
    expect(ui.document.getElementById("run-status")!.textContent).toBe("Não confirmado");
    expect(ui.document.getElementById("run-detail")!.textContent).toContain("Nada foi reenviado");
    expect(ui.document.getElementById("run-detail")!.textContent).toContain("tokens: não medido");
    expect(ui.document.getElementById("reconcile")!.hasAttribute("hidden")).toBe(false);
    expect(ui.document.getElementById("interrupt")!.hasAttribute("hidden")).toBe(true);
    expect(calls.filter(call => call.method === "POST")).toEqual([]);
  });
});

test.each([401, 403])("failed logout %i does not claim the browser session was revoked", async status => {
  const router = defaultRouter(call => call.path === "/api/auth/logout" ? { status, body: { error: { code: status === 401 ? "authentication_required" : "csrf_denied" } } } : undefined);
  await withUi(router, async ui => {
    click(ui.document.getElementById("logout"));
    await settle();
    if (status === 401) {
      expect(ui.document.getElementById("error")!.textContent).toContain("Saída não confirmada");
      expect(ui.document.getElementById("agents")!.children.length).toBe(0);
      expect(ui.document.getElementById("login")!.hasAttribute("hidden")).toBe(false);
    } else {
      expect(ui.document.getElementById("error")!.textContent).toContain("Não foi possível confirmar a saída");
      expect(ui.document.getElementById("logout")!.hasAttribute("hidden")).toBe(false);
    }
  });
});

test("discovery failure keeps known sessions visible and says so", async () => {
  const router = defaultRouter(call => call.path === "/api/dashboard" ? { status: 200, body: dashboard({ discovery_error: "msb_timeout", observed_at: null }) } : undefined);
  await withUi(router, async ui => {
    expect(ui.document.getElementById("status")!.textContent).toContain("msb_timeout");
  });
});

test("hidden UI can never be resurrected by author CSS (login stayed visible after auth on Arch)", async () => {
  const css = await Bun.file(new URL("../public/style.css", import.meta.url)).text();
  expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  await withUi(defaultRouter(), async ui => {
    expect(ui.document.getElementById("login")!.hasAttribute("hidden")).toBe(true);
    expect(ui.document.getElementById("app")!.hasAttribute("hidden")).toBe(false);
  });
});

test("no visible agent: the panel explains why with counts only and points to the local report", async () => {
  const router = defaultRouter(call => call.path === "/api/dashboard" ? { status: 200, body: dashboard({ vms: [], sessions: [],
    discovery: { ok: true, observed_vms: 2, outside_grants: 2, ignored_not_agent: 1, ignored_invalid_project: 1 } }) } : undefined);
  await withUi(router, async ui => {
    const box = ui.document.getElementById("discovery")!;
    expect(box.hasAttribute("hidden")).toBe(false);
    expect(box.textContent).toContain("2 VM(s) de agente fora de COCKPIT_ALLOWED_PROJECTS");
    expect(box.textContent).toContain("1 sandbox(es) que não são agentes");
    expect(box.textContent).toContain("discovery-report");
  });
});

test("agents are grouped by project and filterable without losing the selection", async () => {
  const other = { ...vm, vm_name: "claude-lab", project: "lab", provider: "claude", runnable: false, state: "offline", session_id: null };
  const router = defaultRouter(call => call.path === "/api/dashboard" ? { status: 200, body: dashboard({ vms: [vm, other], projects: ["demo", "lab"] }) } : undefined);
  await withUi(router, async ui => {
    const groups = [...ui.document.querySelectorAll("#agents .project-name")].map(node => node.textContent);
    expect(groups.map(text => text!.slice(0, 4))).toEqual(["demo", "lab"]);
    click(ui.document.querySelector('.agent[data-vm="codex-demo"]'));
    await settle();
    const filter = ui.document.getElementById("filter") as unknown as HTMLInputElement;
    filter.value = "lab";
    (filter as unknown as { dispatchEvent(event: unknown): void }).dispatchEvent(new ui.Event("input"));
    await settle(5);
    expect([...ui.document.querySelectorAll(".agent")].map(node => (node as unknown as { dataset: Record<string, string> }).dataset.vm)).toEqual(["claude-lab"]);
    expect(ui.document.getElementById("vm-title")!.textContent).toBe("codex-demo");
  });
});

test("failed-run notification opens the correct session and shows the classified cause", async () => {
  const failed = { run_id: "run-2", status: "failed", reason_code: "provider_usage_limit", created_at: new Date().toISOString(), ended_at: new Date().toISOString() };
  const two = dashboard({
    attention: [{ kind: "failed_run", run_id: "run-2", session_id: "ses-2", project: "demo", vm_name: "codex-demo", reason_code: "provider_usage_limit", created_at: failed.created_at }],
    sessions: [
      { session_id: "ses-1", project: "demo", vm_name: "codex-demo", thread_id: "thread-0001", last_activity: failed.created_at, latest_run: null, state: "idle" },
      { session_id: "ses-2", project: "demo", vm_name: "codex-demo", thread_id: "thread-0002", last_activity: failed.created_at, latest_run: failed, state: "failed" },
    ],
  });
  const router = defaultRouter(call => {
    if (call.path === "/api/dashboard") return { status: 200, body: two };
    if (call.path === "/api/sessions/ses-2") return { status: 200, body: { session: { session_id: "ses-2" }, runs: [{ ...failed, provider_bound: true, metrics: {} }], approvals: [] } };
    if (call.path === "/api/sessions/ses-2/history") return { status: 200, body: { items: [], runs: [], next_cursor: null } };
    return undefined;
  });
  for (const storage of [{ cockpit_session_proof: "synthetic" }, { cockpit_session_proof: "synthetic", cockpit_view: JSON.stringify({ vm: "codex-demo", sessionId: "ses-1" }) }]) {
    await withUi(router, async (ui, calls) => {
      const open = [...ui.document.querySelectorAll("#attention button")].find(node => node.textContent === "Abrir sessão");
      expect(open).toBeTruthy();
      click(open);
      await settle(120);
      expect(calls.some(call => call.path === "/api/sessions/ses-2")).toBe(true);
      expect((ui.document.getElementById("session-select") as unknown as { value: string }).value).toBe("s:ses-2");
      expect(ui.document.getElementById("run-detail")!.textContent).toContain("quota");
    }, storage);
  }
});

const reasoningItem = { id: "r1", runId: "t1", kind: "reasoning", text: null, status: null, command: null, exitCode: null, files: [] };
const runWith = (status: string) => ({ run_id: "run-i", session_id: "ses-1", status, provider_bound: true, reason_code: null, metrics: { inputTokens: null, durationMs: null } });

test("interrupted run: empty reasoning is not 'Raciocinando…', history is kept, and the end is stated (also after refresh)", async () => {
  const router = defaultRouter(call => {
    if (call.path === "/api/sessions/ses-1") return { status: 200, body: sessionData([runWith("interrupted")]) };
    if (call.path === "/api/sessions/ses-1/history") return { status: 200, body: { items: [{ id: "i2", runId: "t1", kind: "agent_message", text: "resposta anterior", status: null, command: null, exitCode: null, files: [] }, reasoningItem], runs: [], next_cursor: null } };
    return undefined;
  });
  await withUi(router, async ui => {
    click(ui.document.querySelector(".agent"));
    await settle();
    const text = ui.document.getElementById("conversation")!.textContent!;
    expect(text).not.toContain("Raciocinando");
    expect(text).toContain("resposta anterior");
    expect(text).toContain("Execução interrompida");
    expect(ui.document.getElementById("run-status")!.textContent).toBe("Interrompido");
    expect(ui.document.querySelectorAll(".run-end").length).toBe(1);
  });
});

test("running run still shows 'Raciocinando…'; concurrent live events after the interrupt cannot resurrect it", async () => {
  let status = "running";
  const router = defaultRouter(call => {
    if (call.path === "/api/sessions/ses-1") return { status: 200, body: sessionData([runWith(status)]) };
    return undefined;
  });
  await withUi(router, async (ui, _calls, push) => {
    click(ui.document.querySelector(".agent"));
    await settle();
    const live = (phase: string) => push(`event: live\ndata: ${JSON.stringify({ kind: "item", phase, session_id: "ses-1", run_id: "run-i", item: reasoningItem })}\n\n`);
    live("started");
    await settle();
    expect(ui.document.getElementById("conversation")!.textContent).toContain("Raciocinando");
    status = "interrupted";
    push(`event: journal\ndata: ${JSON.stringify({ session_id: "ses-1", cursor: 9, payload: { to: "interrupted" } })}\n\n`);
    await new Promise(resolve => setTimeout(resolve, 700));
    live("started"); // late event arriving after the terminal state
    await settle();
    const text = ui.document.getElementById("conversation")!.textContent!;
    expect(text).not.toContain("Raciocinando");
    expect(text).toContain("Execução interrompida");
    expect(ui.document.querySelectorAll(".run-end").length).toBe(1);
  });
});

test("E1: a blocked agent is flagged in the list and in the inbox with cause and action, not as 'working'", async () => {
  const run = { run_id: "run-b", status: "running", reason_code: null, created_at: new Date().toISOString(), ended_at: null };
  const blocked = dashboard({
    vms: [{ ...vm, state: "blocked", next_step: "Agente travado", run_id: "run-b" }],
    sessions: [{ session_id: "ses-1", project: "demo", vm_name: "codex-demo", thread_id: "thread-0001", last_activity: run.created_at, latest_run: run, state: "blocked" }],
    attention: [{ kind: "blocked", run_id: "run-b", session_id: "ses-1", project: "demo", vm_name: "codex-demo", reason_code: "provider_request_unsupported",
      method: "item/tool/requestUserInput", occurrences: 2, action: "interrupt_and_rephrase", created_at: run.created_at }],
    counts: { working: 0, blocked: 1, awaiting_approval: 0, completed: 0, failed: 0, unknown: 0, interrupted: 0 },
  });
  const router = defaultRouter(call => {
    if (call.path === "/api/dashboard") return { status: 200, body: blocked };
    if (call.path === "/api/sessions/ses-1") return { status: 200, body: sessionData([{ ...run, session_id: "ses-1", provider_bound: true, metrics: {} }]) };
    return undefined;
  });
  await withUi(router, async ui => {
    const card = ui.document.getElementById("attention")!.textContent!;
    expect(card).toContain("Agente travado");
    expect(card).toContain("item/tool/requestUserInput");
    expect(card).toContain("interrompa");
    expect(ui.document.getElementById("attention-count")!.textContent).toBe("1");
    expect(ui.document.querySelector(".agent")!.textContent).toContain("Travado");
    expect(ui.document.querySelector(".agent")!.textContent).not.toContain("Trabalhando");
    expect(ui.document.getElementById("counts")!.textContent).toContain("1 travado");
    click([...ui.document.querySelectorAll("#attention button")].find(node => node.textContent === "Abrir e interromper"));
    await settle(120);
    expect(ui.document.getElementById("run-status")!.textContent).toContain("Travado");
  });
});

// ---------------------------------------------------------------- E3: Claude Code in the same UI
const claudeVm = { ...vm, vm_name: "claude-demo", provider: "claude", session_id: null, sessions: 0,
  capabilities: { resume: true, interrupt: true, approvals: true, questions: true, sessionListing: "cockpit", history: "cockpit", usage: "run", reconcile: "process" } };

test("E3: a Claude question is answered from the inbox by option or free text; nothing is pre-selected; markup stays text", async () => {
  const markup = '<img src=x onerror="globalThis.compromised=true">';
  const question = { kind: "approval", approval_id: "apr-q", run_id: "run-c", session_id: "ses-c", project: "demo", vm_name: "claude-demo", provider: "claude", version: 1,
    action_type: "question", created_at: new Date().toISOString(), summary: { actionType: "question", itemId: null, command: null, cwd: null, reason: null, toolName: "AskUserQuestion",
      questions: [{ question: `Qual banco? ${markup}`, header: "Banco", multiSelect: false, options: [{ label: "Postgres", description: "relacional" }, { label: "SQLite", description: null }] },
        { question: "Quais testes?", header: null, multiSelect: true, options: [{ label: "unit", description: null }, { label: "e2e", description: null }] }] } };
  const decisions: Call[] = [];
  const router = defaultRouter(call => {
    if (call.path === "/api/dashboard") return { status: 200, body: dashboard({ vms: [vm, claudeVm], attention: decisions.length ? [] : [question] }) };
    if (call.method === "POST" && call.path === "/api/approvals/apr-q/decision") { decisions.push(call); return { status: 200, body: { status: "approved", version: 2 } }; }
    return undefined;
  });
  await withUi(router, async ui => {
    const inbox = ui.document.getElementById("attention")!;
    expect(inbox.textContent).toContain("O agente pergunta");
    expect(inbox.textContent).toContain(markup);
    expect(ui.document.querySelectorAll("img").length).toBe(staticImages);
    const inputs = [...inbox.querySelectorAll("input")] as unknown as HTMLInputElement[];
    expect(inputs.map(input => input.type)).toEqual(["radio", "radio", "checkbox", "checkbox"]);
    expect(inputs.some(input => input.checked)).toBe(false);
    // Unanswered → refused locally, nothing posted.
    click([...inbox.querySelectorAll("button")].find(node => node.textContent === "Responder"));
    await settle();
    expect(decisions).toHaveLength(0);
    inputs[1]!.checked = true; inputs[2]!.checked = true; inputs[3]!.checked = true;
    click([...inbox.querySelectorAll("button")].find(node => node.textContent === "Responder"));
    await settle();
    expect(JSON.parse(decisions[0]!.body!)).toEqual({ decision: "approve", expected_version: 1, answers: { [`Qual banco? ${markup}`]: "SQLite", "Quais testes?": "unit, e2e" } });
  });
});

test("E3: a Claude tool approval shows the tool name and its full input; truncation is warned", async () => {
  const approval = { kind: "approval", approval_id: "apr-t", run_id: "run-c", session_id: "ses-c", project: "demo", vm_name: "claude-demo", version: 1, action_type: "tool",
    created_at: new Date().toISOString(), summary: { actionType: "tool", toolName: "WebFetch", itemId: null, command: null, cwd: null, reason: null, files: [],
      detail: '{\n  "url": "https://example.invalid/doc"\n}', truncated: true } };
  let decision: Call | null = null;
  const router = defaultRouter(call => {
    if (call.path === "/api/dashboard") return { status: 200, body: dashboard({ vms: [vm, claudeVm], attention: decision ? [] : [approval] }) };
    if (call.method === "POST" && call.path === "/api/approvals/apr-t/decision") { decision = call; return { status: 200, body: { status: "denied", version: 2 } }; }
    return undefined;
  });
  await withUi(router, async ui => {
    const inbox = ui.document.getElementById("attention")!;
    expect(inbox.textContent).toContain("Aprovar uso de ferramenta: WebFetch");
    expect(inbox.textContent).toContain("https://example.invalid/doc");
    expect(inbox.textContent).toContain("maior do que o exibido");
    click([...inbox.querySelectorAll("button")].find(node => node.textContent === "Rejeitar"));
    await settle();
    expect(JSON.parse(decision!.body!)).toEqual({ decision: "reject", expected_version: 1 });
  });
});

test("E3: a Claude VM offers only Cockpit sessions (no thread listing call), states Cockpit-recorded history and per-run tokens", async () => {
  const session = { session_id: "ses-c", project: "demo", vm_name: "claude-demo", thread_id: "0b7f3c1e-0000-4000-8000-000000000000", last_activity: new Date().toISOString(), latest_run: null, state: "completed" };
  const run = { run_id: "run-c", session_id: "ses-c", status: "completed", provider_bound: true, reason_code: null, metrics: { inputTokens: 12, outputTokens: 3, tokenScope: "run", durationMs: 1200 } };
  const router = defaultRouter(call => {
    if (call.path === "/api/dashboard") return { status: 200, body: dashboard({ vms: [vm, { ...claudeVm, session_id: "ses-c", sessions: 1 }], sessions: [session] }) };
    if (call.path === "/api/sessions/ses-c") return { status: 200, body: { session: { session_id: "ses-c", provider: "claude", capabilities: claudeVm.capabilities }, runs: [run], approvals: [] } };
    if (call.path === "/api/sessions/ses-c/history") return { status: 200, body: { items: [{ id: "t:prompt", runId: "turn-1", kind: "user_message", text: "oi", status: null, command: null, exitCode: null, files: [] },
      { id: "tool:1", runId: "turn-1", kind: "tool", tool: "Grep", text: "3 resultados", status: "completed", command: null, exitCode: null, files: [] }], runs: [], next_cursor: null } };
    return undefined;
  });
  await withUi(router, async (ui, calls) => {
    click([...ui.document.querySelectorAll(".agent")].find(node => node.textContent!.includes("claude-demo")));
    await settle();
    expect(calls.some(call => call.path.includes("/threads"))).toBe(false);
    const conversation = ui.document.getElementById("conversation")!.textContent!;
    expect(conversation).toContain("Histórico registrado pelo Cockpit");
    expect(conversation).toContain("Grep");
    expect(conversation).toContain("3 resultados");
    expect(ui.document.getElementById("run-detail")!.textContent).toContain("tokens (desta execução): 12 in / 3 out");
    expect(ui.document.getElementById("vm-meta")!.textContent).toContain("claude");
  });
});

test("E3: a tool the agent denied by itself, or ran without Cockpit approval, is flagged in the conversation", async () => {
  const session = { session_id: "ses-n", project: "demo", vm_name: "claude-demo", thread_id: "0b7f3c1e-0000-4000-8000-000000000001", last_activity: new Date().toISOString(), latest_run: null, state: "completed" };
  const router = defaultRouter(call => {
    if (call.path === "/api/dashboard") return { status: 200, body: dashboard({ vms: [vm, { ...claudeVm, session_id: "ses-n", sessions: 1 }], sessions: [session] }) };
    if (call.path === "/api/sessions/ses-n") return { status: 200, body: { session: { session_id: "ses-n", provider: "claude", capabilities: claudeVm.capabilities }, runs: [], approvals: [] } };
    if (call.path === "/api/sessions/ses-n/history") return { status: 200, body: { items: [
      { id: "tool:a", runId: "turn-1", kind: "command", command: "touch /tmp/x", text: null, status: "declined", exitCode: null, files: [], notice: "auto_denied" },
      { id: "tool:b", runId: "turn-1", kind: "file_change", text: null, status: "completed", command: null, exitCode: null, files: ["/w/a.md"], notice: "unapproved_execution" },
      { id: "tool:c", runId: "turn-1", kind: "tool", tool: "Grep", text: "ok", status: "completed", command: null, exitCode: null, files: [], notice: "<img src=x onerror=alert(1)>" }], runs: [], next_cursor: null } };
    return undefined;
  });
  await withUi(router, async ui => {
    click([...ui.document.querySelectorAll(".agent")].find(node => node.textContent!.includes("claude-demo")));
    await settle();
    const notices = [...ui.document.querySelectorAll("#conversation .item-notice")].map(node => node.textContent);
    expect(notices).toHaveLength(2); // unknown notice values are ignored, never rendered as markup
    expect(notices[0]).toContain("Negado automaticamente");
    expect(notices[1]).toContain("sem aprovação do Cockpit");
    expect(ui.document.querySelector("#conversation img")).toBeNull();
  });
});

test("E3.1: persisted history after a restart — approvals, answers and incomplete answers are shown; live events and reloads never duplicate", async () => {
  const session = { session_id: "ses-h", project: "demo", vm_name: "claude-demo", thread_id: "0b7f3c1e-0000-4000-8000-000000000002", last_activity: new Date().toISOString(), latest_run: null, state: "unknown" };
  const base = { status: null, command: null, exitCode: null, files: [] };
  const newest = [
    { ...base, id: "run-2:prompt", runId: "run-2", kind: "user_message", text: "Qual opção escolhi?" },
    { ...base, id: "approval:apr-q", runId: "run-2", kind: "approval", text: null, approval: { approvalId: "apr-q", actionType: "question", status: "approved", reasonCode: "human_answer",
      toolName: "AskUserQuestion", command: null, files: [], questions: ["Prioridade?"], answers: { "Prioridade?": "Segurança" } } },
    { ...base, id: "approval:apr-c", runId: "run-2", kind: "approval", text: null, approval: { approvalId: "apr-c", actionType: "command", status: "expired", reasonCode: "process_restarted",
      toolName: "Bash", command: "touch /tmp/x", files: [], questions: [], answers: null } },
    { ...base, id: "turn-2:m:text", runId: "run-2", kind: "agent_message", text: "Você escolheu Segu", status: "in_progress", incomplete: true },
  ];
  const older = [{ ...base, id: "run-1:prompt", runId: "run-1", kind: "user_message", text: "mensagem antiga" }];
  let historyCalls = 0;
  const router = defaultRouter(call => {
    if (call.path === "/api/dashboard") return { status: 200, body: dashboard({ vms: [vm, { ...claudeVm, session_id: "ses-h", sessions: 1 }], sessions: [session] }) };
    if (call.path === "/api/sessions/ses-h") return { status: 200, body: { session: { session_id: "ses-h", provider: "claude", capabilities: claudeVm.capabilities },
      runs: [{ run_id: "run-2", session_id: "ses-h", status: "unknown", provider_bound: true, reason_code: "process_restarted", metrics: {} }], approvals: [] } };
    if (call.path === "/api/sessions/ses-h/history") { historyCalls++; return { status: 200, body: { items: newest, runs: [], next_cursor: "5" } }; }
    if (call.path === "/api/sessions/ses-h/history?before=5") return { status: 200, body: { items: older, runs: [], next_cursor: null } };
    return undefined;
  });
  await withUi(router, async (ui, calls, push) => {
    click([...ui.document.querySelectorAll(".agent")].find(node => node.textContent!.includes("claude-demo")));
    await settle();
    const conversation = () => ui.document.getElementById("conversation")!;
    const text = conversation().textContent!;
    expect(text).not.toContain("Sessão sem mensagens ainda");
    expect(text).toContain("Qual opção escolhi?");
    expect(text).toContain("Pergunta do agente [respondida]");
    expect(text).toContain("Resposta: Segurança");
    expect(text).toContain("Aprovação · Bash [expirada");
    expect(text).toContain("$ touch /tmp/x");
    expect(conversation().querySelector(".item-incomplete")!.textContent).toContain("Resposta incompleta");
    // Older messages are fetched on demand and placed before the newer ones.
    click([...conversation().querySelectorAll("button")].find(node => node.textContent!.includes("Carregar mensagens anteriores")));
    await settle();
    expect(calls.some(call => call.path === "/api/sessions/ses-h/history?before=5")).toBe(true);
    const messages = [...conversation().querySelectorAll(".msg.user")].map(node => node.textContent);
    expect(messages).toEqual(["mensagem antiga", "Qual opção escolhi?"]);
    expect(conversation().textContent).not.toContain("Carregar mensagens anteriores");
    // A live event for an item already shown (SSE replay/reconnect) replaces it in place.
    push(`event: live\ndata: ${JSON.stringify({ kind: "item", phase: "completed", session_id: "ses-h", run_id: "run-2", item: { ...base, id: "turn-2:m:text", kind: "agent_message", status: "completed", text: "Você escolheu Segurança" } })}\n\n`);
    await settle();
    expect([...conversation().querySelectorAll(".msg.agent")].map(node => node.textContent)).toEqual(["Você escolheu Segurança"]);
    // A full reload renders the same conversation once.
    const before = historyCalls;
    click(ui.document.getElementById("refresh"));
    ui.document.getElementById("session-select")!.dispatchEvent(new ui.Event("change"));
    await settle(80);
    expect(historyCalls).toBeGreaterThan(before);
    expect([...conversation().querySelectorAll(".msg.user")].map(node => node.textContent)).toEqual(["Qual opção escolhi?"]);
    expect(conversation().querySelectorAll(".msg.approval").length).toBe(2);
  });
});

// ---------------------------------------------------------------- E4: failures and uncertainty are explicit
test("E4: an orphaned process is shown with its PID, what it blocks and that only the operator ends it; a blocked send says why", async () => {
  const orphan = { kind: "orphan_process", vm_name: "codex-demo", project: "demo", provider: "codex", process_kind: "codex_app_server", pid: 4242,
    session_id: null, blocks: "vm", created_at: new Date().toISOString(), since: new Date().toISOString() };
  const router = defaultRouter(call => {
    if (call.path === "/api/dashboard") return { status: 200, body: dashboard({ attention: [orphan] }) };
    if (call.method === "POST" && call.path === "/api/sessions/ses-1/runs") return { status: 409, body: { error: { code: "orphan_process_alive" } } };
    return undefined;
  });
  await withUi(router, async (ui, calls) => {
    const text = ui.document.getElementById("attention")!.textContent!;
    expect(text).toContain("Processo órfão");
    expect(text).toContain("pid 4242");
    expect(text).toContain("kill 4242");
    expect(text).toContain("bloqueados");
    expect(text).toContain("nunca o encerra sozinho");
    (ui.document.getElementById("prompt") as unknown as { value: string }).value = "nova tarefa";
    click(ui.document.getElementById("send"));
    await settle(80);
    expect(calls.filter(call => call.method === "POST" && call.path === "/api/sessions/ses-1/runs")).toHaveLength(1);
    expect(ui.document.getElementById("error")!.textContent).toContain("Nada foi enviado");
  }, { cockpit_session_proof: "synthetic", cockpit_view: JSON.stringify({ vm: "codex-demo", sessionId: "ses-1" }) });
});

test("E4: an unknown run says what failed (VM stopped) and a reconcile without evidence says why it stays unconfirmed", async () => {
  const unknownRun = { run_id: "run-u", session_id: "ses-1", status: "unknown", provider_bound: true, reason_code: "vm_stopped", lifecycle_version: 5,
    created_at: new Date().toISOString(), ended_at: new Date().toISOString(), metrics: { inputTokens: null, durationMs: null } };
  const router = defaultRouter(call => {
    if (call.path === "/api/sessions/ses-1") return { status: 200, body: sessionData([unknownRun]) };
    if (call.method === "POST" && call.path === "/api/runs/run-u/reconcile") return { status: 200, body: { ...unknownRun, reconciliation: { result: "unconfirmed", reason_code: "provider_cannot_confirm" } } };
    return undefined;
  });
  await withUi(router, async (ui, calls) => {
    expect(ui.document.getElementById("run-status")!.textContent).toBe("Não confirmado");
    expect(ui.document.getElementById("run-detail")!.textContent).toContain("A VM parou");
    click(ui.document.getElementById("reconcile"));
    await settle(80);
    expect(calls.filter(call => call.path === "/api/runs/run-u/reconcile")).toHaveLength(1);
    const error = ui.document.getElementById("error")!.textContent!;
    expect(error).toContain("sem evidência");
    expect(error).toContain("continua não confirmado");
    expect(calls.some(call => call.method === "POST" && call.path.endsWith("/runs"))).toBe(false); // nothing resent
  }, { cockpit_session_proof: "synthetic", cockpit_view: JSON.stringify({ vm: "codex-demo", sessionId: "ses-1" }) });
});

// ---------------------------------------------------------------- brand identity
test("brand: the page's only images are the approved brand rasters, with text alternatives where they carry the name", () => {
  const sources = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(match => [match[1], /\balt="([^"]*)"/.exec(match[0])?.[1]] as const);
  expect(sources.length).toBe(staticImages);
  for (const [src] of sources) expect(src).toMatch(/^\/brand\/(emblem|mark|lockup|wordmark)\.png$/);
  expect(sources.filter(([src]) => src === "/brand/lockup.png" || src === "/brand/wordmark.png").every(([, alt]) => (alt ?? "").includes("Engineering Cockpit"))).toBe(true);
  expect(html).toContain('<link rel="icon" type="image/png" href="/brand/favicon.png">');
});

test("brand: design tokens in CSS match the documented token file (palette of the approved board)", async () => {
  const css = await Bun.file(new URL("../public/style.css", import.meta.url)).text();
  const tokens = await Bun.file(new URL("../assets/brand/tokens.json", import.meta.url)).json() as { color: Record<string, string> };
  expect(tokens.color).toMatchObject({ "ec-steel": "#d9dee6", "ec-deep-navy": "#0a1a2e", "ec-charcoal": "#11161f", "ec-forge-blue": "#1f76ff" });
  for (const [name, value] of Object.entries(tokens.color)) expect(css).toContain(`--${name}: ${value};`);
  expect(css).not.toMatch(/@import|url\(\s*["']?(https?:|\/\/)/); // no external asset
});

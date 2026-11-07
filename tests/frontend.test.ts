import { expect, test } from "bun:test";
import { Window } from "happy-dom";

const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
const javascript = await Bun.file(new URL("../public/app.js", import.meta.url)).text();

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
    expect(ui.document.querySelectorAll("img").length).toBe(0);
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

import { expect, test } from "bun:test";
import { Window } from "happy-dom";

const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
const javascript = await Bun.file(new URL("../public/app.js", import.meta.url)).text();
const snapshot = { source: "mock", host_verification: "not_verified", observed_at: "2026-10-25T00:00:00.000Z", projects: ["demo"], vms: [{ vm_name: "codex-demo", provider: "codex", project: "demo", state: "running", orphaned: false }] };
type Reply = { status: number; body: unknown } | Error;
async function withUi(replies: Reply[], run: (ui: Window, calls: string[], settle: () => Promise<void>) => Promise<void>) {
  const ui = new Window({ url: "http://127.0.0.1:12345/", settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  const calls: string[] = [];
  ui.fetch = (async (input: unknown) => {
    if (String(input) === "/api/auth/session") return new ui.Response(JSON.stringify({ csrf: "synthetic" }), { status: 200, headers: { "Content-Type": "application/json" } });
    calls.push(String(input));
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected_fetch");
    if (reply instanceof Error) throw reply;
    return new ui.Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }) as typeof ui.fetch;
  ui.document.write(html);
  ui.sessionStorage.setItem("cockpit_session_proof", "synthetic");
  const settle = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (calls.length > 0 && !ui.document.getElementById("refresh")!.hasAttribute("disabled")) return;
      await Bun.sleep(1);
    }
    throw new Error("frontend_did_not_settle");
  };
  try { ui.eval(javascript); await settle(); await run(ui, calls, settle); }
  finally { await ui.happyDOM.close(); }
}
test("frontend executes discovery and selection locally without issuing a command", async () => {
  await withUi([{ status: 200, body: snapshot }], async (ui, calls) => {
    expect(ui.document.getElementById("source")!.textContent).toContain("SIMULAÇÃO");
    expect(ui.document.getElementById("projects")!.textContent).toContain("demo");
    const button = ui.document.querySelector(".vm")!;
    expect(button.textContent).toContain("running");
    button.dispatchEvent(new ui.MouseEvent("click", { bubbles: true }));
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(ui.document.getElementById("selection")!.textContent).toContain("codex-demo (somente leitura)");
    expect(calls).toEqual(["/api/vms"]);
  });
});
test("frontend clears inventory and selection after a failed refresh, then recovers", async () => {
  await withUi([{ status: 200, body: snapshot }, { status: 503, body: { error: { code: "msb_timeout" } } }, { status: 200, body: snapshot }], async (ui, calls, settle) => {
    const refresh = ui.document.getElementById("refresh")!;
    ui.document.querySelector(".vm")!.dispatchEvent(new ui.MouseEvent("click"));
    refresh.dispatchEvent(new ui.MouseEvent("click")); await settle();
    expect(ui.document.getElementById("vms")!.children.length).toBe(0);
    expect(ui.document.getElementById("projects")!.children.length).toBe(0);
    expect(ui.document.getElementById("selection")!.textContent).toBe("Nenhuma VM selecionada.");
    expect(ui.document.getElementById("error")!.textContent).toContain("msb_timeout");
    expect(ui.document.getElementById("error")!.hasAttribute("hidden")).toBe(false);
    expect(ui.document.getElementById("status")!.textContent).toBe("Discovery indisponível");
    refresh.dispatchEvent(new ui.MouseEvent("click")); await settle();
    expect(ui.document.querySelectorAll(".vm").length).toBe(1);
    expect(ui.document.getElementById("error")!.hasAttribute("hidden")).toBe(true);
    expect(calls).toEqual(["/api/vms", "/api/vms", "/api/vms"]);
  });
});
test("frontend handles empty and host-labeled observations without claiming host verification", async () => {
  await withUi([{ status: 200, body: { ...snapshot, source: "host", projects: [], vms: [] } }], async ui => {
    expect(ui.document.getElementById("projects")!.textContent).toContain("Nenhum projeto autorizado");
    expect(ui.document.getElementById("vms")!.textContent).toContain("Nenhuma VM observada");
    expect(ui.document.getElementById("source")!.textContent).toContain("source: host");
    expect(ui.document.getElementById("source")!.textContent).toContain("not_verified");
  });
});
test("frontend shows orphan VM and does not add a fictional project", async () => {
  const orphan = { vm_name: "codex-charybdis-nano", provider: "codex", project: "charybdis-nano", state: "running", orphaned: true };
  await withUi([{ status: 200, body: { ...snapshot, source: "host", vms: [...snapshot.vms, orphan] } }], async ui => {
    expect(ui.document.querySelectorAll(".vm").length).toBe(2);
    expect(ui.document.getElementById("vms")!.textContent).toContain("codex-charybdis-nano");
    expect(ui.document.getElementById("vms")!.textContent).toContain("ÓRFÃ: diretório de projeto ausente");
    expect(ui.document.getElementById("projects")!.textContent).not.toContain("charybdis-nano");
  });
});
test("frontend renders untrusted markup as text and network failures as explicit errors", async () => {
  const markup = '<img src=x onerror="globalThis.compromised=true">';
  await withUi([{ status: 200, body: { ...snapshot, projects: [markup], vms: [{ ...snapshot.vms[0], vm_name: markup }] } }, new Error("offline")], async (ui, calls, settle) => {
    expect(ui.document.querySelectorAll("img").length).toBe(0);
    expect(ui.document.getElementById("projects")!.textContent).toContain(markup);
    expect(ui.document.querySelector(".vm")!.textContent).toContain(markup);
    ui.document.getElementById("refresh")!.dispatchEvent(new ui.MouseEvent("click")); await settle();
    expect(ui.document.getElementById("error")!.textContent).toContain("offline");
    expect(ui.document.querySelectorAll(".vm").length).toBe(0);
    expect(calls).toEqual(["/api/vms", "/api/vms"]);
  });
});
test.each([401, 403])("failed logout %i does not claim the browser session was revoked", async status => {
  await withUi([{ status: 200, body: snapshot }, { status, body: { error: { code: status === 401 ? "authentication_required" : "csrf_denied" } } }], async (ui, calls) => {
    ui.document.getElementById("logout")!.dispatchEvent(new ui.MouseEvent("click"));
    for (let attempt = 0; attempt < 100 && ui.document.getElementById("error")!.hasAttribute("hidden"); attempt++) await Bun.sleep(1);
    expect(calls).toEqual(["/api/vms", "/api/auth/logout"]);
    if (status === 401) {
      expect(ui.document.getElementById("error")!.textContent).toContain("Saída não confirmada");
      expect(ui.document.getElementById("vms")!.children.length).toBe(0);
      expect(ui.document.getElementById("login")!.hasAttribute("hidden")).toBe(false);
    } else {
      expect(ui.document.getElementById("error")!.textContent).toContain("Não foi possível confirmar a saída");
      expect(ui.document.getElementById("logout")!.hasAttribute("hidden")).toBe(false);
    }
  });
});

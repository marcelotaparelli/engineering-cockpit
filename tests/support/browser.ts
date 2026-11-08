import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Chromium driver for the acceptance scenarios: Chrome DevTools Protocol over Bun's WebSocket, no npm dependency (same technique
 * as scripts/visual-check.ts). Headless, throw-away profile in the default TMPDIR (a long TMPDIR makes Chromium die with
 * "Socket path too long"), nothing shared with the operator's own browser, no network beyond the loopback Cockpit under test.
 */
export function findChromium(env: Record<string, string | undefined> = process.env): string | null {
  if (env.CHROMIUM) return Bun.which(env.CHROMIUM) ?? (env.CHROMIUM.startsWith("/") ? env.CHROMIUM : null);
  for (const name of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) { const found = Bun.which(name); if (found) return found; }
  return null;
}

export interface Page {
  readonly consoleErrors: string[];
  cdp(method: string, params?: Record<string, unknown>): Promise<any>;
  /** Evaluates an expression in the page (promises awaited, result by value). */
  js<T = unknown>(expression: string): Promise<T>;
  /** Polls an expression until truthy. */
  until(expression: string, timeoutMs?: number): Promise<boolean>;
  shot(name: string): Promise<void>;
  goto(url: string): Promise<void>;
  /** A real key press (reaches the page's capturing keydown listeners, i.e. counts as operator input). */
  press(key?: string): Promise<void>;
  visible(selector: string): Promise<boolean>;
  text(selector: string): Promise<string>;
  click(selector: string): Promise<void>;
  /** Clicks the first element of `selector` whose text equals `label`. */
  clickByText(selector: string, label: string): Promise<void>;
  close(): void;
}
export interface Browser { newPage(url?: string): Promise<Page>; close(): Promise<void> }

export const visibleExpression = (selector: string) => `(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; const r = n.getBoundingClientRect(); return getComputedStyle(n).display !== 'none' && r.width > 0 && r.height > 0; })()`;

export async function launchBrowser(chromium: string, shotsDir?: string): Promise<Browser> {
  if (shotsDir) await mkdir(shotsDir, { recursive: true });
  const profile = await mkdtemp(join(tmpdir(), "cockpit-chromium-"));
  const child = Bun.spawn([chromium, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`,
    "--remote-debugging-port=0", "about:blank"], { stdout: "ignore", stderr: "pipe" });
  const reader = child.stderr.getReader();
  let text = "";
  let endpoint = "";
  for (const deadline = Date.now() + 20_000; !endpoint && Date.now() < deadline;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
    endpoint = /DevTools listening on (ws:\/\/\S+)/.exec(text)?.[1] ?? "";
  }
  reader.releaseLock();
  if (!endpoint) { child.kill(); await rm(profile, { recursive: true, force: true }); throw new Error("chromium_did_not_start"); }
  // Keep draining stderr so the child never blocks on a full pipe.
  void (async () => { try { for await (const _ of child.stderr) { /* drained */ } } catch { /* closed */ } })();
  const http = endpoint.replace("ws://", "http://").replace(/\/devtools\/browser\/.*/, "");
  const pages = new Set<Page>();

  async function attach(wsUrl: string, name: string): Promise<Page> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", () => reject(new Error("cdp_connect_failed")), { once: true }); });
    let seq = 0;
    const waiting = new Map<number, (value: any) => void>();
    const consoleErrors: string[] = [];
    ws.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.id && waiting.has(message.id)) { waiting.get(message.id)!(message); waiting.delete(message.id); }
      if (message.method === "Runtime.exceptionThrown") consoleErrors.push(message.params.exceptionDetails.text);
      if (message.method === "Log.entryAdded" && message.params.entry.level === "error") consoleErrors.push(message.params.entry.text);
    });
    let closed = false;
    ws.addEventListener("close", () => { closed = true; for (const [id, done] of waiting) { done({ error: { message: "page_closed" } }); waiting.delete(id); } });
    const cdp = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
      if (closed) { reject(new Error(`${method}: page_closed`)); return; }
      const id = ++seq;
      waiting.set(id, message => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result));
      ws.send(JSON.stringify({ id, method, params }));
    });
    const js = async <T,>(expression: string): Promise<T> => {
      const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.text} ${expression.slice(0, 120)}`);
      return result.result.value as T;
    };
    const until = async (expression: string, timeoutMs = 5000) => {
      for (const end = Date.now() + timeoutMs; Date.now() < end; await Bun.sleep(50)) { try { if (await js<boolean>(expression)) return true; } catch { /* navigation in flight */ } }
      return false;
    };
    await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Log.enable");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const page: Page = {
      consoleErrors, cdp, js, until,
      shot: async file => { if (!shotsDir) return; const r = await cdp("Page.captureScreenshot", { format: "png" }); await Bun.write(join(shotsDir, `${name}-${file}`), Buffer.from(r.data, "base64")); },
      goto: async url => { await cdp("Page.navigate", { url }); },
      press: async (key = "Shift") => { await cdp("Input.dispatchKeyEvent", { type: "keyDown", key }); await cdp("Input.dispatchKeyEvent", { type: "keyUp", key }); },
      visible: selector => js<boolean>(visibleExpression(selector)),
      text: selector => js<string>(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`),
      click: async selector => { if (!await js<boolean>(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; n.click(); return true; })()`)) throw new Error(`no_element ${selector}`); },
      clickByText: async (selector, label) => {
        if (!await js<boolean>(`(() => { const n = [...document.querySelectorAll(${JSON.stringify(selector)})].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (!n) return false; n.click(); return true; })()`)) throw new Error(`no_element ${selector} "${label}"`);
      },
      close: () => { pages.delete(page); try { ws.close(); } catch { /* closed */ } },
    };
    pages.add(page);
    return page;
  }

  let first = true;
  return {
    async newPage(url?: string) {
      const list = await (await fetch(`${http}/json/list`)).json() as Array<{ id: string; type: string; webSocketDebuggerUrl: string }>;
      let target = first ? list.find(p => p.type === "page") : undefined;
      if (!target) {
        const created = await (await fetch(`${http}/json/new?about:blank`, { method: "PUT" })).json() as { id: string; webSocketDebuggerUrl: string };
        target = { ...created, type: "page" };
      }
      first = false;
      const page = await attach(target.webSocketDebuggerUrl, `p${pages.size + 1}`);
      if (url) await page.goto(url);
      return page;
    },
    async close() {
      for (const page of [...pages]) page.close();
      child.kill();
      await child.exited.catch(() => {});
      await rm(profile, { recursive: true, force: true });
    },
  };
}

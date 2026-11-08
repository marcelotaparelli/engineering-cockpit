import { SafeError, safeCode, type Snapshot } from "./model.ts";
import type { Discovery } from "./discovery.ts";
import { LocalSecurity, type LocalPrincipal } from "./local-security.ts";
import type { RuntimeStore, RunRecord, SessionRecord } from "./runtime-store.ts";
import type { ExecutionService } from "./execution.ts";
import type { EventHub } from "./event-hub.ts";
import { buildDashboard } from "./dashboard.ts";

export interface RequestLog {
  event: "request" | "security_denied" | "auth_succeeded" | "auth_failed" | "csrf_denied" | "replay_denied" | "authz_denied";
  request_id: string;
  trace_id: string;
  route: string;
  duration_ms: number;
  status: number;
  error_code: string | null;
}
export interface ServerOptions {
  discovery: Pick<Discovery, "refresh"> & Partial<Pick<Discovery, "ignored" | "cached">>;
  source: "mock" | "host";
  port: number;
  security: LocalSecurity;
  runtime?: RuntimeStore;
  execution?: ExecutionService;
  hub?: EventHub;
  log?: (entry: RequestLog) => void;
  heartbeatMs?: number;
}
const assets: Record<string, { body: string; type: string }> = {};
for (const [path, file, type] of [
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/app.js", "app.js", "text/javascript; charset=utf-8"],
  ["/style.css", "style.css", "text/css; charset=utf-8"],
] as const) {
  assets[path] = { body: await Bun.file(new URL(`../public/${file}`, import.meta.url)).text(), type };
}

const ID = "([A-Za-z0-9][A-Za-z0-9._:-]{0,127})";
type RouteName =
  | "/" | "/app.js" | "/style.css" | "/api/health" | "/api/auth/login" | "/api/auth/logout" | "/api/auth/session"
  | "/api/vms" | "/api/projects" | "/api/vms/:id" | "/api/projects/:id" | "/api/vms/:id/threads" | "/api/dashboard" | "/api/events"
  | "/api/sessions" | "/api/sessions/:id" | "/api/sessions/:id/history" | "/api/sessions/:id/runs"
  | "/api/runs/:id" | "/api/runs/:id/interrupt" | "/api/runs/:id/reconcile" | "/api/approvals" | "/api/approvals/:id/decision";
const ROUTES: ReadonlyArray<{ name: RouteName; method: "GET" | "POST"; pattern: RegExp }> = [
  { name: "/", method: "GET", pattern: /^\/$/ },
  { name: "/app.js", method: "GET", pattern: /^\/app\.js$/ },
  { name: "/style.css", method: "GET", pattern: /^\/style\.css$/ },
  { name: "/api/health", method: "GET", pattern: /^\/api\/health$/ },
  { name: "/api/auth/login", method: "POST", pattern: /^\/api\/auth\/login$/ },
  { name: "/api/auth/logout", method: "POST", pattern: /^\/api\/auth\/logout$/ },
  { name: "/api/auth/session", method: "GET", pattern: /^\/api\/auth\/session$/ },
  { name: "/api/vms", method: "GET", pattern: /^\/api\/vms$/ },
  { name: "/api/projects", method: "GET", pattern: /^\/api\/projects$/ },
  { name: "/api/vms/:id/threads", method: "GET", pattern: new RegExp(`^/api/vms/${ID}/threads$`) },
  { name: "/api/vms/:id", method: "GET", pattern: new RegExp(`^/api/vms/${ID}$`) },
  { name: "/api/projects/:id", method: "GET", pattern: /^\/api\/projects\/([a-z0-9][a-z0-9_-]{0,62})$/ },
  { name: "/api/dashboard", method: "GET", pattern: /^\/api\/dashboard$/ },
  { name: "/api/events", method: "GET", pattern: /^\/api\/events$/ },
  { name: "/api/sessions", method: "POST", pattern: /^\/api\/sessions$/ },
  { name: "/api/sessions/:id", method: "GET", pattern: new RegExp(`^/api/sessions/${ID}$`) },
  { name: "/api/sessions/:id/history", method: "GET", pattern: new RegExp(`^/api/sessions/${ID}/history$`) },
  { name: "/api/sessions/:id/runs", method: "POST", pattern: new RegExp(`^/api/sessions/${ID}/runs$`) },
  { name: "/api/runs/:id", method: "GET", pattern: new RegExp(`^/api/runs/${ID}$`) },
  { name: "/api/runs/:id/interrupt", method: "POST", pattern: new RegExp(`^/api/runs/${ID}/interrupt$`) },
  { name: "/api/runs/:id/reconcile", method: "POST", pattern: new RegExp(`^/api/runs/${ID}/reconcile$`) },
  { name: "/api/approvals", method: "GET", pattern: /^\/api\/approvals$/ },
  { name: "/api/approvals/:id/decision", method: "POST", pattern: new RegExp(`^/api/approvals/${ID}/decision$`) },
];
const staticRoutes = new Set<RouteName>(["/", "/app.js", "/style.css"]);
const securityHeaders = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

async function readJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type") !== "application/json") throw new SafeError("content_type_denied");
  const reader = request.body?.getReader();
  if (!reader) throw new SafeError("invalid_body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new SafeError("invalid_body");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new SafeError("invalid_body"); }
}
/** Exact-shape body: every key must be listed, required ones present. */
function exact(body: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const keys = Object.keys(body);
  if (required.some(key => !keys.includes(key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) throw new SafeError("invalid_body");
}
async function readLogin(request: Request): Promise<unknown> {
  const body = await readJson(request, 1024);
  exact(body, ["credential"]);
  return body.credential;
}
const CONFLICTS = new Set(["idempotency_key_conflict", "project_busy", "session_busy", "run_version_conflict", "approval_conflict", "approval_expired",
  "run_not_interruptible", "target_unavailable", "invalid_run_transition"]);
function errorStatus(code: string): number {
  if (code === "authentication_required" || code === "authentication_failed") return 401;
  if (code === "auth_rate_limited" || code === "nonce_capacity_reached") return 429;
  if (code === "resource_not_found" || code === "route_not_found") return 404;
  if (code === "method_not_allowed") return 405;
  if (code === "query_not_allowed" || code === "content_type_denied" || code === "invalid_body" || code === "invalid_prompt" ||
    code === "invalid_idempotency_key" || code === "idempotency_key_required" || code === "invalid_history_cursor" || code === "invalid_limit") return 400;
  if (code === "request_origin_denied" || code === "csrf_denied" || code === "replay_denied") return 403;
  if (CONFLICTS.has(code)) return 409;
  if (/^(provider|rpc|transport|msb)_/.test(code)) return 502;
  return 500;
}
/** Question answers: 1–4 entries, bounded question text keys and answer values, no NUL. Semantic checks happen in the adapter. */
function answersBody(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SafeError("invalid_body");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 4) throw new SafeError("invalid_body");
  for (const [key, answer] of entries) {
    if (!key || key.length > 512 || key.includes("\0") || typeof answer !== "string" || !answer.trim() || answer.length > 2000 || answer.includes("\0")) throw new SafeError("invalid_body");
  }
  return Object.fromEntries(entries) as Record<string, string>; // own properties only (no prototype keys)
}
export function runView(store: RuntimeStore, run: RunRecord): Record<string, unknown> {
  return {
    run_id: run.runId, session_id: run.sessionId, status: run.status, lifecycle_version: run.lifecycleVersion,
    execution_count: run.executionCount, reason_code: run.reasonCode, created_at: run.createdAt, started_at: run.startedAt,
    ended_at: run.endedAt, provider_bound: run.providerRunId !== null, metrics: store.metrics(run),
  };
}
export function sessionView(session: SessionRecord, execution?: ExecutionService): Record<string, unknown> {
  return { session_id: session.sessionId, project: session.target.projectId, vm_name: session.target.vmName, provider: session.target.provider,
    thread_id: session.providerSessionId, created_at: session.createdAt, last_activity: session.lastObservedAt,
    capabilities: execution?.capabilities(session.target.provider) ?? null };
}

/** `?before=<cursor>&limit=<1..500>`, each at most once, nothing else. */
function historyQuery(params: URLSearchParams): { before: string | undefined; limit: number | undefined } {
  const keys = [...params.keys()];
  if (keys.some(key => key !== "before" && key !== "limit") || new Set(keys).size !== keys.length) throw new SafeError("query_not_allowed");
  const before = params.get("before") ?? undefined;
  const rawLimit = params.get("limit");
  if (before !== undefined && !/^[1-9][0-9]{0,15}$/.test(before)) throw new SafeError("invalid_history_cursor");
  if (rawLimit !== null && (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 500)) throw new SafeError("invalid_limit");
  return { before, limit: rawLimit === null ? undefined : Number(rawLimit) };
}

export function startServer(options: ServerOptions): Bun.Server<undefined> {
  const log = options.log ?? (entry => console.log(JSON.stringify(entry)));
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const requireRuntime = (): RuntimeStore => { if (!options.runtime) throw new SafeError("resource_not_found"); return options.runtime; };
  const requireExecution = (): ExecutionService => { if (!options.execution) throw new SafeError("resource_not_found"); return options.execution; };

  function stream(principal: LocalPrincipal, lastEventId: string | null): Response {
    const store = requireRuntime();
    if (!options.hub) throw new SafeError("resource_not_found");
    const hub = options.hub;
    const projects = [...principal.grants];
    let cursor = lastEventId !== null && /^(0|[1-9][0-9]{0,15})$/.test(lastEventId) ? Number(lastEventId) : store.lastSequence();
    let cleanup = () => {};
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let flushQueued = false;
        const send = (text: string) => {
          if (closed) return;
          if (!options.security.isActive(principal)) { close(); return; }
          // Slow consumer: drop the stream rather than buffer without bound. The client resumes by cursor.
          if (controller.desiredSize !== null && controller.desiredSize < -2000) { close(); return; }
          try { controller.enqueue(encoder.encode(text)); } catch { close(); }
        };
        const flush = () => {
          flushQueued = false;
          if (closed) return;
          try {
            for (;;) {
              const rows = store.replayForProjects(projects, cursor, 200);
              for (const row of rows) {
                cursor = row.sequence;
                send(`id: ${row.sequence}\nevent: journal\ndata: ${JSON.stringify({ sequence: row.sequence, type: row.type, run_id: row.runId,
                  session_id: row.sessionId, project: row.projectId, occurred_at: row.occurredAt, payload: row.payload })}\n\n`);
              }
              if (rows.length < 200) break;
            }
          } catch { close(); }
        };
        const unsubscribe = hub.subscribe({
          projects: principal.grants,
          onLive: event => send(`event: live\ndata: ${JSON.stringify({ kind: event.kind, project: event.projectId, session_id: event.sessionId, run_id: event.runId, ...event.data })}\n\n`),
          onJournal: () => { if (!flushQueued) { flushQueued = true; queueMicrotask(flush); } },
        });
        const heartbeat = setInterval(() => {
          if (!options.security.isActive(principal)) { close(); return; }
          send(`: hb ${Date.now()}\n\n`);
        }, heartbeatMs);
        function close() {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          try { controller.close(); } catch { /* already closed */ }
        }
        cleanup = close;
        send(`retry: 2000\n: cursor ${cursor}\n\n`);
        flush();
      },
      cancel() { cleanup(); },
    }, { highWaterMark: 64 });
    return new Response(body, { status: 200, headers: { ...securityHeaders, "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" } });
  }

  return Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: 60,
    async fetch(request, currentServer) {
      const start = performance.now();
      const requestId = crypto.randomUUID();
      const traceId = crypto.randomUUID().replaceAll("-", "");
      const url = new URL(request.url);
      const matching = ROUTES.map(route => ({ route, match: route.pattern.exec(url.pathname) })).filter(item => item.match);
      const selected = matching.find(item => item.route.method === request.method) ?? matching[0];
      const route: RouteName | "unmatched" = selected?.route.name ?? "unmatched";
      const param = selected?.match?.[1] ?? "";
      let status = 200;
      let errorCode: string | null = null;
      let event: RequestLog["event"] = "request";
      const headers = new Headers({ ...securityHeaders, "X-Request-Id": requestId, "X-Trace-Id": traceId });
      const json = (body: unknown, code = status) => {
        status = code;
        headers.set("Content-Type", "application/json; charset=utf-8");
        return new Response(JSON.stringify(body), { status, headers });
      };
      try {
        const expectedHost = `127.0.0.1:${currentServer.port}`;
        const origin = request.headers.get("origin");
        const fetchSite = request.headers.get("sec-fetch-site");
        if (request.headers.get("host") !== expectedHost || url.host !== expectedHost ||
          (origin !== null && origin !== `http://${expectedHost}`) ||
          (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") ||
          (request.method === "POST" && origin !== `http://${expectedHost}`)) throw new SafeError("request_origin_denied");
        // Only the history page accepts a query (strictly `before`/`limit`, parsed below); everything else stays query-free.
        if (url.search && route !== "/api/sessions/:id/history") throw new SafeError("query_not_allowed");
        if (route === "unmatched") {
          if (request.method !== "GET") { headers.set("Allow", "GET"); throw new SafeError("method_not_allowed"); }
          throw new SafeError("route_not_found");
        }
        if (selected!.route.method !== request.method) { headers.set("Allow", selected!.route.method); throw new SafeError("method_not_allowed"); }
        if (route === "/api/health") return json({ status: "ok", source: options.source, host_verification: "not_verified", host_readiness: "not_verified" });
        if (route === "/api/auth/login") {
          const credential = await readLogin(request);
          const prior = (() => { try { return options.security.authenticate(request.headers.get("cookie"), request.headers.get("x-session-proof")); } catch { return null; } })();
          const session = options.security.login(credential, prior ?? undefined);
          headers.set("Set-Cookie", `cockpit_session=${session.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`);
          event = "auth_succeeded";
          return json({ csrf: session.csrf, proof: session.proof });
        }
        if (staticRoutes.has(route)) {
          const asset = assets[route]!;
          headers.set("Content-Type", asset.type);
          return new Response(asset.body, { status, headers });
        }
        const principal = options.security.authenticate(request.headers.get("cookie"), request.headers.get("x-session-proof"));
        if (route === "/api/auth/session") return json(options.security.sessionInfo(principal));

        // Every other POST is a state-changing operation: JSON only, CSRF bound to the session, single-use nonce.
        let body: Record<string, unknown> = {};
        if (request.method === "POST") {
          if (request.headers.get("content-type") !== "application/json") throw new SafeError("content_type_denied");
          options.security.csrf(principal, request.headers.get("x-csrf-token"), request.headers.get("x-request-nonce"));
          body = await readJson(request, route === "/api/sessions/:id/runs" ? 256 * 1024 : 4096);
        }
        if (route === "/api/auth/logout") {
          options.security.logout(principal);
          headers.set("Set-Cookie", "cockpit_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
          return json({ status: "logged_out" });
        }
        if (route === "/api/events") {
          const response = stream(principal, request.headers.get("last-event-id"));
          currentServer.timeout(request, 0);
          for (const [key, value] of headers) if (key.startsWith("x-")) response.headers.set(key, value);
          return response;
        }
        if (route === "/api/runs/:id") {
          const store = requireRuntime();
          const { run } = options.security.authorizeRun(store, principal, param);
          return json({ ...runView(store, run), approvals: store.pendingApprovals().filter(item => item.runId === run.runId)
            .map(item => options.execution?.approvalView(item) ?? item) });
        }
        if (route === "/api/runs/:id/interrupt" || route === "/api/runs/:id/reconcile") {
          exact(body, []);
          const store = requireRuntime();
          const { run, session } = options.security.authorizeRun(store, principal, param);
          const updated = route === "/api/runs/:id/interrupt" ? await requireExecution().interrupt(run, session) : await requireExecution().reconcile(run, session);
          return json(runView(store, updated), route === "/api/runs/:id/interrupt" ? 202 : 200);
        }
        if (route === "/api/sessions/:id") {
          const store = requireRuntime();
          const session = options.security.authorizeSession(store, principal, param);
          const runs = store.listRuns(session.sessionId, 50);
          return json({ session: sessionView(session, options.execution), runs: runs.map(run => runView(store, run)),
            approvals: store.pendingApprovals().filter(item => runs.some(run => run.runId === item.runId)).map(item => requireExecution().approvalView(item)).filter(Boolean) });
        }
        if (route === "/api/sessions/:id/history") {
          const session = options.security.authorizeSession(requireRuntime(), principal, param);
          const { before, limit } = historyQuery(url.searchParams);
          const page = await requireExecution().history(session, before, limit);
          return json({ session_id: session.sessionId, items: page.items, runs: page.runs, next_cursor: page.nextCursor });
        }
        if (route === "/api/sessions/:id/runs") {
          const store = requireRuntime();
          const session = options.security.authorizeSession(store, principal, param);
          const key = request.headers.get("idempotency-key");
          if (!key) throw new SafeError("idempotency_key_required");
          if (!IDEMPOTENCY_KEY.test(key)) throw new SafeError("invalid_idempotency_key");
          exact(body, ["prompt"]);
          const { run, created } = await requireExecution().startRun(session, body.prompt as string, key);
          return json({ ...runView(store, run), replayed: !created }, created ? 202 : 200);
        }
        if (route === "/api/approvals") {
          const store = requireRuntime();
          const execution = requireExecution();
          const approvals = store.pendingApprovals().map(item => execution.approvalView(item)).filter(view => view && principal.grants.has(view.projectId));
          return json({ approvals });
        }
        if (route === "/api/approvals/:id/decision") {
          const store = requireRuntime();
          exact(body, ["decision", "expected_version"], ["answers"]);
          if ((body.decision !== "approve" && body.decision !== "reject") || !Number.isSafeInteger(body.expected_version)) throw new SafeError("invalid_body");
          const answers = body.answers === undefined ? undefined : answersBody(body.answers);
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(param)) throw new SafeError("resource_not_found");
          const approval = store.getApproval(param);
          if (!approval) throw new SafeError("resource_not_found");
          options.security.authorizeRun(store, principal, approval.runId);
          const decided = await requireExecution().decide(approval, body.decision, body.expected_version as number, answers);
          return json({ approval_id: decided.approvalId, status: decided.status, version: decided.version });
        }
        if (route === "/api/dashboard") {
          const store = requireRuntime();
          let snapshot: Snapshot | null = null;
          let discoveryError: string | null = null;
          try { snapshot = await (options.discovery.cached?.() ?? options.discovery.refresh()); } catch (error) { discoveryError = safeCode(error); }
          return json(buildDashboard({ store, execution: options.execution, principal, security: options.security, snapshot, discoveryError, source: options.source, ignored: options.discovery.ignored ?? null }));
        }

        let snapshot;
        try { snapshot = await options.discovery.refresh(); }
        catch (error) { status = 503; throw error; }
        if (route === "/api/projects/:id") {
          options.security.authorizeProject(principal, param);
          if (!snapshot.projects.includes(param)) throw new SafeError("resource_not_found");
          return json({ project: param });
        }
        if (route === "/api/vms/:id") {
          const vm = options.security.authorizeVm(snapshot, principal, param);
          return json({ vm });
        }
        if (route === "/api/vms/:id/threads") {
          const vm = options.security.authorizeVm(snapshot, principal, param);
          const execution = requireExecution();
          const target = await execution.revalidate(vm.vm_name, vm.project);
          return json({ vm_name: vm.vm_name, threads: await execution.listThreads(target) });
        }
        if (route === "/api/sessions") {
          exact(body, ["vm_name", "mode"], ["thread_id"]);
          if (typeof body.vm_name !== "string" || (body.mode !== "new" && body.mode !== "resume")) throw new SafeError("invalid_body");
          if (body.mode === "resume" ? typeof body.thread_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.thread_id) : body.thread_id !== undefined) {
            throw new SafeError("invalid_body");
          }
          const vm = options.security.authorizeVm(snapshot, principal, body.vm_name);
          const execution = requireExecution();
          const target = await execution.revalidate(vm.vm_name, vm.project);
          const session = await execution.openSession(target, body.mode, body.thread_id as string | undefined);
          return json(sessionView(session, execution), 201);
        }
        const visible = options.security.visible(snapshot, principal);
        const { projects, vms, ...meta } = visible;
        return json(route === "/api/projects" ? { ...meta, projects } : { ...meta, projects, vms });
      } catch (error) {
        errorCode = safeCode(error);
        if (status === 200) status = errorStatus(errorCode);
        event = errorCode === "authentication_required" || errorCode === "authentication_failed" || errorCode === "auth_rate_limited" ? "auth_failed"
          : errorCode === "csrf_denied" ? "csrf_denied" : errorCode === "replay_denied" ? "replay_denied"
          : errorCode === "resource_not_found" ? "authz_denied" : CONFLICTS.has(errorCode) || status >= 500 ? "request" : "security_denied";
        return json({ error: { code: errorCode }, source: options.source, host_verification: "not_verified", request_id: requestId }, status);
      } finally {
        log({ event, request_id: requestId, trace_id: traceId, route, duration_ms: Math.round((performance.now() - start) * 100) / 100, status, error_code: errorCode });
      }
    },
  });
}

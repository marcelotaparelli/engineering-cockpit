import { SafeError, safeCode } from "./model.ts";
import type { Discovery } from "./discovery.ts";
import { LocalSecurity } from "./local-security.ts";
import type { RuntimeStore } from "./runtime-store.ts";

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
  discovery: Pick<Discovery, "refresh">;
  source: "mock" | "host";
  port: number;
  security: LocalSecurity;
  runtime?: Pick<RuntimeStore, "getRun" | "getSession">;
  log?: (entry: RequestLog) => void;
}
const assets: Record<string, { body: string; type: string }> = {};
for (const [path, file, type] of [
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/app.js", "app.js", "text/javascript; charset=utf-8"],
  ["/style.css", "style.css", "text/css; charset=utf-8"],
] as const) {
  assets[path] = { body: await Bun.file(new URL(`../public/${file}`, import.meta.url)).text(), type };
}
const staticRoutes = new Set(Object.keys(assets));
const readRoutes = new Set(["/api/health", "/api/vms", "/api/projects", "/api/auth/session"]);
const securityHeaders = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
async function readLogin(request: Request): Promise<unknown> {
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
      if (size > 1024) throw new SafeError("invalid_body");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 || !("credential" in parsed)) throw new Error();
    return parsed.credential;
  } catch { throw new SafeError("invalid_body"); }
}
function errorStatus(code: string): number {
  if (code === "authentication_required" || code === "authentication_failed") return 401;
  if (code === "auth_rate_limited" || code === "nonce_capacity_reached") return 429;
  if (code === "resource_not_found" || code === "route_not_found") return 404;
  if (code === "method_not_allowed") return 405;
  if (code === "query_not_allowed" || code === "content_type_denied" || code === "invalid_body") return 400;
  if (code === "request_origin_denied" || code === "csrf_denied" || code === "replay_denied") return 403;
  return 500;
}
export function startServer(options: ServerOptions): Bun.Server<undefined> {
  const log = options.log ?? (entry => console.log(JSON.stringify(entry)));
  return Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    async fetch(request, currentServer) {
      const start = performance.now();
      const requestId = crypto.randomUUID();
      const traceId = crypto.randomUUID().replaceAll("-", "");
      const url = new URL(request.url);
      const runRoute = /^\/api\/runs\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(url.pathname);
      const vmRoute = /^\/api\/vms\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(url.pathname);
      const projectRoute = /^\/api\/projects\/([a-z0-9][a-z0-9_-]{0,62})$/.exec(url.pathname);
      const route = readRoutes.has(url.pathname) || staticRoutes.has(url.pathname) ? url.pathname
        : runRoute ? "/api/runs/:id" : vmRoute ? "/api/vms/:id" : projectRoute ? "/api/projects/:id"
        : url.pathname === "/api/auth/login" || url.pathname === "/api/auth/logout" ? url.pathname : "unmatched";
      let status = 200;
      let errorCode: string | null = null;
      let event: RequestLog["event"] = "request";
      const headers = new Headers({ ...securityHeaders, "X-Request-Id": requestId, "X-Trace-Id": traceId });
      const json = (body: unknown) => {
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
        if (url.search) throw new SafeError("query_not_allowed");
        if (route === "unmatched") {
          if (request.method !== "GET") { headers.set("Allow", "GET"); throw new SafeError("method_not_allowed"); }
          throw new SafeError("route_not_found");
        }
        const allowedMethod = route === "/api/auth/login" || route === "/api/auth/logout" ? "POST" : "GET";
        if (request.method !== allowedMethod) { headers.set("Allow", allowedMethod); throw new SafeError("method_not_allowed"); }
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
        if (route === "/api/auth/logout") {
          if (request.headers.get("content-type") !== "application/json") throw new SafeError("content_type_denied");
          options.security.csrf(principal, request.headers.get("x-csrf-token"), request.headers.get("x-request-nonce"));
          options.security.logout(principal);
          headers.set("Set-Cookie", "cockpit_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
          return json({ status: "logged_out" });
        }
        if (runRoute) {
          if (!options.runtime) throw new SafeError("resource_not_found");
          const { run } = options.security.authorizeRun(options.runtime, principal, runRoute[1]!);
          return json({ run_id: run.runId, status: run.status, lifecycle_version: run.lifecycleVersion,
            execution_count: run.executionCount, reason_code: run.reasonCode });
        }
        let snapshot;
        try { snapshot = await options.discovery.refresh(); }
        catch (error) { status = 503; throw error; }
        if (projectRoute) {
          const project = projectRoute[1]!;
          options.security.authorizeProject(principal, project);
          if (!snapshot.projects.includes(project)) throw new SafeError("resource_not_found");
          return json({ project });
        }
        if (vmRoute) {
          const vm = options.security.authorizeVm(snapshot, principal, vmRoute[1]!);
          return json({ vm });
        }
        const visible = options.security.visible(snapshot, principal);
        const { projects, vms, ...meta } = visible;
        return json(route === "/api/projects" ? { ...meta, projects } : { ...meta, projects, vms });
      } catch (error) {
        errorCode = safeCode(error);
        if (status === 200) status = errorStatus(errorCode);
        event = errorCode === "authentication_required" || errorCode === "authentication_failed" || errorCode === "auth_rate_limited" ? "auth_failed"
          : errorCode === "csrf_denied" ? "csrf_denied" : errorCode === "replay_denied" ? "replay_denied"
          : errorCode === "resource_not_found" ? "authz_denied" : "security_denied";
        return json({ error: { code: errorCode }, source: options.source, host_verification: "not_verified", request_id: requestId });
      } finally {
        log({ event, request_id: requestId, trace_id: traceId, route, duration_ms: Math.round((performance.now() - start) * 100) / 100, status, error_code: errorCode });
      }
    },
  });
}

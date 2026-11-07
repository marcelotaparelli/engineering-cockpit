import { fileURLToPath } from "node:url";
import { SafeError } from "./model.ts";
export interface Config { source: "mock" | "host"; projectsBase: string; databasePath: string; runtimeDatabasePath: string; port: number; localCredential: string; allowedProjects: string[] }
export function config(env: Record<string, string | undefined> = process.env): Config {
  const mode = env.COCKPIT_MODE ?? "mock";
  if (mode !== "mock" && mode !== "host") throw new SafeError("invalid_mode");
  if (mode === "host" && env.COCKPIT_HOST_CONFIRMED !== "yes") throw new SafeError("host_confirmation_required");
  const port = env.PORT ?? "0";
  if (!/^(0|[1-9][0-9]{0,4})$/.test(port) || Number(port) > 65535) throw new SafeError("invalid_port");
  if (mode === "host" && !env.COCKPIT_PROJECTS_BASE?.startsWith("/")) throw new SafeError("host_projects_base_required");
  const localCredential = env.COCKPIT_LOCAL_TOKEN ?? "";
  const allowedProjects = (env.COCKPIT_ALLOWED_PROJECTS ?? "").split(",");
  return {
    source: mode,
    projectsBase: mode === "mock" ? fileURLToPath(new URL("../fixtures/projects", import.meta.url)) : env.COCKPIT_PROJECTS_BASE!,
    databasePath: fileURLToPath(new URL(`../data/cockpit-${mode}.sqlite`, import.meta.url)),
    runtimeDatabasePath: fileURLToPath(new URL(`../data/runtime-${mode}/runtime.sqlite`, import.meta.url)),
    port: Number(port),
    localCredential,
    allowedProjects,
  };
}

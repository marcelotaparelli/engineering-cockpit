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
  // Optional isolated state directory (tests/visual checks). Absolute, no traversal; symlinks are refused by the stores.
  const dataDir = env.COCKPIT_DATA_DIR;
  if (dataDir !== undefined && (!dataDir.startsWith("/") || dataDir.split("/").includes(".."))) throw new SafeError("invalid_data_dir");
  const data = (name: string) => dataDir ? `${dataDir.replace(/\/+$/, "")}/${name}` : fileURLToPath(new URL(`../data/${name}`, import.meta.url));
  return {
    source: mode,
    projectsBase: mode === "mock" ? fileURLToPath(new URL("../fixtures/projects", import.meta.url)) : env.COCKPIT_PROJECTS_BASE!,
    databasePath: data(`cockpit-${mode}.sqlite`),
    runtimeDatabasePath: data(`runtime-${mode}/runtime.sqlite`),
    port: Number(port),
    localCredential,
    allowedProjects,
  };
}

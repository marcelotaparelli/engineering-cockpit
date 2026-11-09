import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SafeError } from "./model.ts";
import { reservations, reservedVms } from "./reservations.ts";

export { reservedVms };

export interface Config {
  source: "mock" | "host"; projectsBase: string; databasePath: string; runtimeDatabasePath: string; port: number; localCredential: string;
  /** Configuration grants (`COCKPIT_ALLOWED_PROJECTS`). May be empty: projects can then be authorized from the UI. */
  allowedProjects: string[];
  /**
   * Reserved projects (P-D4): never authorized (configuration or UI), executed or served. The development project (D8),
   * `COCKPIT_RESERVED_PROJECTS` and the project of every reserved VM.
   */
  reservedProjects: string[];
  /** UI grants persisted here; null when `COCKPIT_UI_GRANTS=off` (configuration grants only, as before). */
  grantsDatabasePath: string | null;
  /** VMs the Cockpit never operates: the development VM (D8), `COCKPIT_RESERVED_VMS`, and every provider's VM of a reserved project. */
  reservedVms: string[];
}

/** Exit status of a refused startup (configuration, host, credential, database ownership). systemd must not restart it. */
export const EXIT_STARTUP_REFUSED = 78; // EX_CONFIG

export function config(env: Record<string, string | undefined> = process.env, readCredentialFile: (path: string) => string = readLocalCredentialFile): Config {
  const mode = env.COCKPIT_MODE ?? "mock";
  if (mode !== "mock" && mode !== "host") throw new SafeError("invalid_mode");
  if (mode === "host" && env.COCKPIT_HOST_CONFIRMED !== "yes") throw new SafeError("host_confirmation_required");
  const port = env.PORT ?? "0";
  if (!/^(0|[1-9][0-9]{0,4})$/.test(port) || Number(port) > 65535) throw new SafeError("invalid_port");
  if (mode === "host" && !env.COCKPIT_PROJECTS_BASE?.startsWith("/")) throw new SafeError("host_projects_base_required");
  // F1: the credential may come from a private file (systemd service) instead of the environment; never both.
  const tokenFile = env.COCKPIT_LOCAL_TOKEN_FILE;
  if (tokenFile !== undefined && env.COCKPIT_LOCAL_TOKEN !== undefined) throw new SafeError("local_credential_ambiguous");
  const localCredential = tokenFile !== undefined ? readCredentialFile(tokenFile) : env.COCKPIT_LOCAL_TOKEN ?? "";
  // Unset or empty = no configuration grant (projects are then authorized from the UI). Any other malformed value is refused later.
  const allowedProjects = env.COCKPIT_ALLOWED_PROJECTS === undefined || env.COCKPIT_ALLOWED_PROJECTS === "" ? [] : env.COCKPIT_ALLOWED_PROJECTS.split(",");
  const uiGrants = env.COCKPIT_UI_GRANTS ?? "on";
  if (uiGrants !== "on" && uiGrants !== "off") throw new SafeError("invalid_ui_grants");
  // Optional isolated state directory (tests/visual checks). Absolute, no traversal; symlinks are refused by the stores.
  const dataDir = env.COCKPIT_DATA_DIR;
  if (dataDir !== undefined && (!dataDir.startsWith("/") || dataDir.split("/").includes(".."))) throw new SafeError("invalid_data_dir");
  const data = (name: string) => dataDir ? `${dataDir.replace(/\/+$/, "")}/${name}` : fileURLToPath(new URL(`../data/${name}`, import.meta.url));
  // P-D4: every reserved VM reserves its project for all providers; the effective VM list covers every provider of those projects.
  const reserved = reservations(env.COCKPIT_RESERVED_VMS, env.COCKPIT_RESERVED_PROJECTS);
  return {
    source: mode,
    projectsBase: mode === "mock" ? fileURLToPath(new URL("../fixtures/projects", import.meta.url)) : env.COCKPIT_PROJECTS_BASE!,
    databasePath: data(`cockpit-${mode}.sqlite`),
    runtimeDatabasePath: data(`runtime-${mode}/runtime.sqlite`),
    port: Number(port),
    localCredential,
    allowedProjects,
    reservedProjects: reserved.projects,
    grantsDatabasePath: uiGrants === "on" ? data(`grants-${mode}.sqlite`) : null,
    reservedVms: reserved.vms,
  };
}

/**
 * Reads the local credential from a private file without following links: a regular file owned by this user, no group/other
 * permission bits, inside a directory owned by this user and not writable by others. The value never reaches the environment.
 */
export function readLocalCredentialFile(path: string): string {
  if (!path.startsWith("/") || path.split("/").includes("..")) throw new SafeError("local_credential_file_invalid");
  const uid = process.getuid?.();
  let dir;
  try { dir = lstatSync(dirname(path)); } catch { throw new SafeError("local_credential_file_invalid"); }
  if (!dir.isDirectory() || (uid !== undefined && dir.uid !== uid) || (dir.mode & 0o022) !== 0) throw new SafeError("local_credential_file_insecure");
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new SafeError("local_credential_file_invalid"); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 256) throw new SafeError("local_credential_file_invalid");
    if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) throw new SafeError("local_credential_file_insecure");
    const buffer = Buffer.alloc(257);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, length).toString("utf8");
    buffer.fill(0);
    const value = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (!/^[a-f0-9]{64}$/.test(value)) throw new SafeError("local_credential_file_invalid");
    return value;
  } finally { closeSync(fd); }
}

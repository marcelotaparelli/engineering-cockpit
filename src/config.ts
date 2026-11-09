import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SafeError, vmIdentity } from "./model.ts";
import { DEFAULT_RESERVED_VMS } from "./claude-protocol.ts";
import { reservedProjects } from "./project-grants.ts";

export interface Config {
  source: "mock" | "host"; projectsBase: string; databasePath: string; runtimeDatabasePath: string; port: number; localCredential: string;
  /** Configuration grants (`COCKPIT_ALLOWED_PROJECTS`). May be empty: projects can then be authorized from the UI. */
  allowedProjects: string[];
  /** Projects the UI never authorizes: the development project (D8) plus `COCKPIT_RESERVED_PROJECTS`. */
  reservedProjects: string[];
  /** UI grants persisted here; null when `COCKPIT_UI_GRANTS=off` (configuration grants only, as before). */
  grantsDatabasePath: string | null;
  /** VMs the Cockpit never operates (listed as `unsupported`): the development VM (D8) plus `COCKPIT_RESERVED_VMS`. */
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
  return {
    source: mode,
    projectsBase: mode === "mock" ? fileURLToPath(new URL("../fixtures/projects", import.meta.url)) : env.COCKPIT_PROJECTS_BASE!,
    databasePath: data(`cockpit-${mode}.sqlite`),
    runtimeDatabasePath: data(`runtime-${mode}/runtime.sqlite`),
    port: Number(port),
    localCredential,
    allowedProjects,
    reservedProjects: reservedProjects(env.COCKPIT_RESERVED_PROJECTS),
    grantsDatabasePath: uiGrants === "on" ? data(`grants-${mode}.sqlite`) : null,
    reservedVms: reservedVms(env.COCKPIT_RESERVED_VMS),
  };
}

/**
 * The development VM (D8 default) is ALWAYS reserved; `COCKPIT_RESERVED_VMS` (comma-separated agent VM names) only adds to it.
 * An empty or mistyped value can therefore never unprotect it: lifting that reservation stays a code change (Tech Lead, D8).
 */
export function reservedVms(value: string | undefined): string[] {
  const names = (value ?? "").split(",").filter(name => name !== "");
  if (new Set(names).size !== names.length) throw new SafeError("invalid_reserved_vms");
  for (const name of names) { try { vmIdentity(name); } catch { throw new SafeError("invalid_reserved_vms"); } }
  return [...new Set([...DEFAULT_RESERVED_VMS, ...names])];
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

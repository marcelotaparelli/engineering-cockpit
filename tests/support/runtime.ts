import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "../../src/service.ts";

/**
 * Hermetic stand-ins for the Bun runtime, so service tests do not depend on the machine they run on: not on the version of the
 * Bun that executes the suite, not on a project-local `tools/runtime` (present on the Arch checkout, absent on Debian), not on
 * `process.execPath`.
 */
export const pinnedVersion = (await Bun.file(join(repoRoot(), ".bun-version")).text()).trim();

/** An executable named `bun` in `dir` that answers `--version` with `version` (default: the pinned one). */
export async function fakeBun(dir: string, version = pinnedVersion, mode = 0o755): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, "bun");
  await writeFile(file, `#!/bin/sh\necho ${version}\n`);
  await chmod(file, mode);
  return file;
}

/**
 * A repository root made only of what runtime resolution reads: `.bun-version`, and optionally a project-local runtime.
 * Never the real checkout, so its `tools/runtime` cannot leak into a test.
 */
export async function bareRoot(dir: string, local?: { version?: string; mode?: number } | "none"): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".bun-version"), `${pinnedVersion}\n`);
  if (local && local !== "none") await fakeBun(join(dir, "tools/runtime/node_modules/.bin"), local.version ?? pinnedVersion, local.mode ?? 0o755);
  return dir;
}

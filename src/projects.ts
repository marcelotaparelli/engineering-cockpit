import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SafeError, validProject } from "./model.ts";
import { assertNoSymlinks } from "./paths.ts";

export async function listProjects(base: string): Promise<string[]> {
  try {
    assertNoSymlinks(base);
    const root = await lstat(base);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new SafeError("invalid_project_base");
    const entries = await readdir(base, { withFileTypes: true });
    const projects: string[] = [];
    for (const entry of entries) {
      if (!validProject(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const info = await lstat(join(base, entry.name));
      if (info.isDirectory() && !info.isSymbolicLink()) projects.push(entry.name);
    }
    return projects.sort();
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError("project_discovery_failed");
  }
}

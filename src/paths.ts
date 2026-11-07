import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SafeError } from "./model.ts";

// Metadata only: refuse symbolic links in every existing path component.
export function assertNoSymlinks(path: string): void {
  let current = resolve(path);
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new SafeError("symlink_path_denied");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

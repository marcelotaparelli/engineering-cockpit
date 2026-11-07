import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { SafeError } from "./model.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
export async function artifactManifest(): Promise<string> {
  const files = [".bun-version", ".gitignore", "README.md", "package.json", "bun.lock", "tsconfig.json", "engineering-cockpit-M0-kickoff.md"];
  async function collect(dir: string): Promise<void> {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile()) files.push(path);
      else throw new SafeError("artifact_symlink_denied");
    }
  }
  for (const dir of ["src", "public", "tests", "fixtures", "scripts"]) await collect(dir);
  const lines = [];
  for (const file of files.sort()) lines.push(`${createHash("sha256").update(await readFile(join(root, file))).digest("hex")}  ${file}`);
  return lines.join("\n") + "\n";
}

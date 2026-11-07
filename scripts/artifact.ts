import { readFile, writeFile } from "node:fs/promises";
import { artifactManifest } from "../src/artifact.ts";
const manifest = await artifactManifest();
const target = new URL("../docs/artifact.sha256", import.meta.url);
if (process.argv[2] === "--check") {
  if (await readFile(target, "utf8") !== manifest) throw new Error("artifact_manifest_mismatch");
  console.log("PASS artifact manifest");
} else if (process.argv.length === 2) {
  await writeFile(target, manifest);
  console.log("Wrote docs/artifact.sha256 (code, fixtures, locks and README; excludes reports/runtime binaries)");
} else throw new Error("usage: bun scripts/artifact.ts [--check]");

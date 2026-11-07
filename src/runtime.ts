import { readFileSync } from "node:fs";
import { SafeError } from "./model.ts";
export function assertRuntime(): void {
  if (Bun.version !== readFileSync(new URL("../.bun-version", import.meta.url), "utf8").trim()) throw new SafeError("bun_version_mismatch");
}

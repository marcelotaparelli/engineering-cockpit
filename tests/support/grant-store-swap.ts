/**
 * Subprocess fixture (module mocks stay out of the main test process): swaps the grant store for a hard-linked, 0644 store
 * holding a planted grant right before the N-th `lstat` of its path, then reports whether GrantStore refused it or opened it.
 * Usage: bun tests/support/grant-store-swap.ts <dir> <N>   → prints {"n":N,"outcome":"refused"|"opened","grants":[...]}
 */
import { mock } from "bun:test";
import * as realFs from "node:fs";
import { join } from "node:path";

const [dir, nArg] = process.argv.slice(2) as [string, string];
const n = Number(nArg);
const path = join(dir, "grants.sqlite");
const copy: Record<string, unknown> = {};
for (const key of Object.keys(realFs)) copy[key] = (realFs as Record<string, unknown>)[key];
let armed = false;
let calls = 0;
const lstat = realFs.lstatSync;
mock.module("node:fs", () => ({ ...copy, default: { ...copy }, lstatSync: (p: string, ...rest: unknown[]) => {
  if (armed && p === path && ++calls === n) realFs.renameSync(join(dir, "evil.sqlite"), path);
  return (lstat as (...args: unknown[]) => unknown)(p, ...rest);
} }));
const { GrantStore } = await import("../../src/grant-store.ts");
const audit = { actor: "local_operator:0123456789abcdef", requestId: "r1", at: "2026-01-01T00:00:00.000Z" };
new GrantStore(path).close();
const source = join(dir, "evil-src.sqlite");
const evil = new GrantStore(source);
evil.grant("evilproj", audit);
evil.close();
realFs.chmodSync(source, 0o644);
realFs.linkSync(source, join(dir, "evil.sqlite"));
armed = true;
try {
  const opened = new GrantStore(path);
  console.log(JSON.stringify({ n, outcome: "opened", swapped: calls >= n, grants: opened.list().map(row => row.project) }));
} catch (error) {
  console.log(JSON.stringify({ n, outcome: "refused", swapped: calls >= n, code: (error as Error).message }));
}

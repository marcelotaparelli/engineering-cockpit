import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../src/service.ts";

/**
 * The F1 acceptance matrix (docs/f1-aceite-automatizado.md §4) must not rot: every id is present once and in order, every row
 * says how it is covered and its state, every `file` / `file#excerpt` reference resolves, and a row declared automatic names at
 * least one reference. The browser scenarios tag each check with a matrix id, and every tag must exist in the matrix.
 */
const root = repoRoot();
const doc = readFileSync(join(root, "docs/f1-aceite-automatizado.md"), "utf8");
const table = doc.slice(doc.indexOf("## 4. Matriz de cobertura"), doc.indexOf("## 5. Evidências produzidas"));
const rows = table.split("\n").filter(line => /^\| F1-\d{2} \|/.test(line)).map(line => line.split("|").slice(1, -1).map(cell => cell.trim()));
const STATES = ["AUTO", "ATESTADO", "HUMANO", "EXTERNO", "pendente"];
const refs = (cell: string) => [...cell.matchAll(/`((?:tests|scripts|src|docs)\/[^`#]+)(?:#([^`]+))?`/g)].map(match => ({ file: match[1]!, excerpt: match[2] ?? null }));

test("the matrix lists F1-01..F1-35 once each, in order, with six columns", () => {
  expect(rows.map(row => row[0])).toEqual(Array.from({ length: 35 }, (_, index) => `F1-${String(index + 1).padStart(2, "0")}`));
  for (const row of rows) { expect(row).toHaveLength(6); for (const cell of row) expect(cell).not.toBe(""); }
});

test("every reference resolves: the file exists and, with #excerpt, contains it", () => {
  const broken: string[] = [];
  for (const row of rows) for (const ref of refs(row[2]!)) {
    const path = join(root, ref.file);
    if (!existsSync(path)) { broken.push(`${row[0]}: ${ref.file} (missing)`); continue; }
    if (ref.excerpt && !readFileSync(path, "utf8").includes(ref.excerpt)) broken.push(`${row[0]}: ${ref.file}#${ref.excerpt}`);
  }
  expect(broken).toEqual([]);
});

test("a row whose state is automatic has references; every other state says why in words", () => {
  for (const row of rows) {
    const state = row[5]!;
    expect(`${row[0]} ${STATES.some(candidate => state.startsWith(candidate))}`).toBe(`${row[0]} true`);
    if (state.startsWith("AUTO")) expect(`${row[0]} ${refs(row[2]!).length > 0}`).toBe(`${row[0]} true`);
    if (state.startsWith("HUMANO") || state.startsWith("EXTERNO") || state.startsWith("pendente")) expect(row[2]!.length + row[3]!.length).toBeGreaterThan(10);
  }
});

test("every matrix id tagged in the browser acceptance script exists in the matrix, and every browser reference is tagged there", () => {
  const script = readFileSync(join(root, "scripts/f1-browser-acceptance.ts"), "utf8");
  const tagged = new Set([...script.matchAll(/(?:check|noteIdle|noteCeiling)\("(F1-\d{2})"/g)].map(match => match[1]!));
  const ids = new Set(rows.map(row => row[0]));
  expect([...tagged].filter(id => !ids.has(id))).toEqual([]);
  expect(tagged.size).toBeGreaterThanOrEqual(12);
  // The rows that claim browser coverage by this script must be tagged in it (the reference check above covers the excerpt itself).
  for (const row of rows) if (refs(row[2]!).some(ref => ref.file === "scripts/f1-browser-acceptance.ts")) expect(`${row[0]} ${tagged.has(row[0]!)}`).toBe(`${row[0]} true`);
});

test("the F1 checklist sources are the ones the matrix cites: the master plan F1 acceptance and the V1 criteria exist", () => {
  const plan = readFileSync(join(root, "docs/master-plan.md"), "utf8");
  expect(plan).toContain("um dia inteiro de uso real");
  expect(plan).toContain("## 8. Critérios de aceite da V1");
  expect(readFileSync(join(root, "docs/f1-operacao-diaria.md"), "utf8")).toContain("## 6. Homologação no Arch (operador)");
});

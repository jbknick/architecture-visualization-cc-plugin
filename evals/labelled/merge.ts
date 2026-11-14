/**
 * Merges `candidates.jsonl` (from sample.ts) with hand-drafted labels into the private
 * `devprentice.jsonl` and writes the operator's `review.md` scan table.
 *
 * Usage: pnpm tsx evals/labelled/merge.ts
 * Env:   LABELLED_OUT (default <repo>/evals/private/labelled)
 *
 * Label drafts live in `<out>/draft-labels-*.json` as arrays of
 * `[candidateIndex, behavior, nameFits, suggestedName?]`, indexed by line in candidates.jsonl.
 * Everything read and written here is private; nothing is ever committed.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.env.LABELLED_OUT ?? join(here, "..", "private", "labelled"));

const candidates = readFileSync(join(out, "candidates.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { id: string; factSheet: { path: string }; stratum: string });

const labels = new Map<number, [number, string, boolean, string?]>();
for (const f of readdirSync(out)
  .filter((n) => /^draft-labels-.*\.json$/.test(n))
  .sort()) {
  for (const row of JSON.parse(readFileSync(join(out, f), "utf8")) as [number, string, boolean, string?][]) {
    if (labels.has(row[0])) throw new Error(`duplicate label for index ${row[0]} in ${f}`);
    labels.set(row[0], row);
  }
}

const lines: string[] = [];
const table: string[] = [];
candidates.forEach((c, i) => {
  const l = labels.get(i);
  if (!l) throw new Error(`missing label for candidate ${i}`);
  const [, behavior, nameFits, suggestedName] = l;
  const label = nameFits ? { behavior, nameFits } : { behavior, nameFits, suggestedName };
  lines.push(JSON.stringify({ id: c.id, factSheet: c.factSheet, label, stratum: c.stratum }));
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  table.push(
    `| ${i} | ${c.stratum} | \`${esc(c.id.replace(/^sym:/, ""))}\` | ${esc(behavior)} | ${nameFits} | ${suggestedName ?? ""} |`,
  );
});

writeFileSync(join(out, "devprentice.jsonl"), `${lines.join("\n")}\n`);
const falseCount = [...labels.values()].filter((l) => !l[2]).length;
writeFileSync(
  join(out, "review.md"),
  [
    "# Labelled set review (PRIVATE, do not commit)",
    "",
    "Draft labels by Claude. Scan each row; correct `behavior`, `nameFits` or `suggestedName` in place,",
    "then tell the agent the corrections so they are applied to `devprentice.jsonl`.",
    "",
    `Rows: ${candidates.length}. nameFits=false: ${falseCount} (${((100 * falseCount) / candidates.length).toFixed(1)}%).`,
    "",
    "| # | stratum | id | draft behavior | nameFits | suggestedName |",
    "|---|---|---|---|---|---|",
    ...table,
    "",
  ].join("\n"),
);
console.error(`wrote ${lines.length} rows; nameFits=false ${falseCount}`);

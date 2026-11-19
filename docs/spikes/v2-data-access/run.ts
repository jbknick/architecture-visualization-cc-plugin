// Spike: hand-written data-access recipes (SQL text, text rules, model naming and method classes on top of the five
// generic helpers) against the hand labels of 13 pinned public repos, and the Drizzle recipe against today's adapter.
// Usage (repo root): pnpm tsx docs/spikes/v2-data-access/run.ts [--only name...]
// Needs the pinned clones (pnpm eval:clone) and `npm install` in this directory. Writes results.json next to this
// file: scores, determinism and the Drizzle comparison, no timings (timings are printed).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Dump,
  type KindScore,
  loadCase,
  type Repo,
  score,
  targetDir,
} from "../../../scripts/eval-lib.js";
import { type Recipe, type RecipeOutput, runRecipe } from "./engine.js";
import { type RefGraph, referenceGraph } from "./reference.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx > 0 ? process.argv.slice(onlyIdx + 1) : [];

/** One row per stack: the repo, the recipe, whether the stack blocks the release (V2 plan, "Which stacks block"). */
const STACKS = [
  { stack: "drizzle", repo: "next-js-boilerplate", recipe: "drizzle", blocking: true, language: "ts" },
  { stack: "prisma", repo: "fastify-typescript", recipe: "prisma", blocking: true, language: "ts" },
  { stack: "typeorm", repo: "nestjs-boilerplate", recipe: "typeorm", blocking: false, language: "ts" },
  {
    stack: "kysely",
    repo: "bun-fastify-starter-turbo-monorepo",
    recipe: "kysely",
    blocking: false,
    language: "ts",
  },
  {
    stack: "sequelize",
    repo: "nestjs-sequelize-typescript",
    recipe: "sequelize",
    blocking: false,
    language: "ts",
  },
  {
    stack: "mikro-orm",
    repo: "express-ts-example-app",
    recipe: "mikro-orm",
    blocking: false,
    language: "ts",
  },
  {
    stack: "mongoose",
    repo: "express-mongodb-rest-api-boilerplate",
    recipe: "mongoose",
    blocking: false,
    language: "ts",
  },
  { stack: "raw-sql", repo: "pg-boss", recipe: "raw-sql", blocking: true, language: "ts" },
  { stack: "database-sql", repo: "ecom", recipe: "database-sql", blocking: true, language: "go" },
  { stack: "sqlx", repo: "openencoder", recipe: "sqlx", blocking: true, language: "go" },
  { stack: "sqlc", repo: "simplebank", recipe: "sqlc", blocking: false, language: "go" },
  { stack: "gorm", repo: "myapp", recipe: "gorm", blocking: true, language: "go" },
  { stack: "ent", repo: "ent", recipe: "ent", blocking: false, language: "go" },
].filter((s) => only.length === 0 || only.includes(s.stack));

const readRecipe = (name: string): Recipe =>
  JSON.parse(readFileSync(path.join(here, "recipes", `${name}.json`), "utf8")) as Recipe;

/** The recipe output in the shape `index --dump` has, so `pnpm eval:score --dump` reads it. */
function toDump(o: RecipeOutput): Dump {
  const paths = [...new Set([...o.tables.map((t) => t.file), ...o.accesses.map((a) => a.file)])].sort();
  const fileId = (p: string) => `file:${p}`;
  const nodes = o.tables.map((t) => ({
    id: `table:${t.name}`,
    kind: "table",
    data: { adapter: "recipe", name: t.name, ...(t.model ? { model: t.model } : {}) },
  }));
  const seen = new Set<string>();
  const edges = o.accesses
    .filter((a) => {
      const k = `${a.file}|${a.table}|${a.kind}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((a) => ({
      src: `file:${a.file}`,
      dst: `table:${a.table}`,
      kind: a.kind === "read" ? "reads" : "writes",
      confidence: a.confidence,
      fileId: fileId(a.file),
    }));
  return { files: paths.map((p) => ({ id: fileId(p), path: p })), edges, adapterNodes: nodes } as Dump;
}

const strip = (o: RecipeOutput) => JSON.stringify({ ...o, ms: undefined });
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const round = (n: number) => Math.round(n * 10000) / 10000;
const medianMs = (xs: number[]) =>
  (xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number) / 1;

const results: Record<string, unknown> = {};
const stacks: Record<string, unknown>[] = [];
const timings: Record<string, number> = {};

for (const s of STACKS) {
  const { repo, labels } = loadCase(s.repo, {}) as {
    repo: Repo;
    labels: ReturnType<typeof loadCase>["labels"];
  };
  const root = targetDir(repo);
  const recipe = readRecipe(s.recipe);
  const outs: RecipeOutput[] = [];
  for (let i = 0; i < 3; i++) outs.push(runRecipe(root, recipe));
  const first = outs[0] as RecipeOutput;
  const hashes = outs.map((o) => sha(strip(o)));
  const dumpText = JSON.stringify(toDump(first));
  const dumpHashes = outs.map((o) => sha(JSON.stringify(toDump(o))));
  const deterministic = hashes.every((h) => h === hashes[0]) && dumpHashes.every((h) => h === dumpHashes[0]);
  const sc = score(s.repo, labels, toDump(first));
  const kinds = sc.kinds as Record<string, KindScore>;
  const recall = Math.min(...["table", "read", "write"].map((k) => (kinds[k] as KindScore).recall));
  const precision = Math.min(...["table", "read", "write"].map((k) => (kinds[k] as KindScore).precision));
  timings[s.stack] = medianMs(outs.map((o) => o.ms.total));
  stacks.push({
    stack: s.stack,
    repo: s.repo,
    sha7: repo.sha.slice(0, 7),
    language: s.language,
    blocking: s.blocking,
    labels: {
      table: (kinds.table as KindScore).labelled,
      read: (kinds.read as KindScore).labelled,
      write: (kinds.write as KindScore).labelled,
    },
    kinds: Object.fromEntries(
      ["table", "read", "write"].map((k) => {
        const x = kinds[k] as KindScore;
        return [
          k,
          {
            labelled: x.labelled,
            predicted: x.predicted,
            matched: x.matched,
            recall: x.recall,
            precision: x.precision,
          },
        ];
      }),
    ),
    recall: round(recall),
    precision: round(precision),
    pass: recall >= 0.9 && precision >= 0.95,
    helpersDeclared: recipe.helpers,
    helpersFired: first.helperUse,
    deterministic,
    runs: 3,
    dumpSha: dumpHashes[0],
    lowConfidence: first.lowConfidence.length,
    lowConfidenceReasons: [...new Set(first.lowConfidence.map((l) => l.reason))].sort(),
    missed: sc.missed,
    extra: sc.extra,
  });
  console.log(
    `${s.stack.padEnd(13)} ${s.blocking ? "BLOCK" : "     "} R ${(recall * 100).toFixed(1)}% P ${(precision * 100).toFixed(1)}%  ` +
      `tables ${(kinds.table as KindScore).matched}/${(kinds.table as KindScore).labelled} (+${(kinds.table as KindScore).predicted - (kinds.table as KindScore).matched}) ` +
      `reads ${(kinds.read as KindScore).matched}/${(kinds.read as KindScore).labelled} (+${(kinds.read as KindScore).predicted - (kinds.read as KindScore).matched}) ` +
      `writes ${(kinds.write as KindScore).matched}/${(kinds.write as KindScore).labelled} (+${(kinds.write as KindScore).predicted - (kinds.write as KindScore).matched}) ` +
      `det ${deterministic} median ${timings[s.stack]?.toFixed(0)}ms`,
  );
  void dumpText;
}
results.stacks = stacks;

// --- Drizzle recipe against today's adapter, on both fixtures ---------------------------------------------------
if (only.length === 0 || only.includes("drizzle")) {
  const drizzle = readRecipe("drizzle");
  const fixtures: Record<string, unknown> = {};
  for (const fx of ["pnpm-turbo", "adapters"]) {
    const root = path.join(repoRoot, "fixtures", fx);
    const ref: RefGraph = await referenceGraph(root);
    const outs = [0, 1, 2].map(() => runRecipe(root, drizzle));
    const out = outs[0] as RecipeOutput;
    const deterministic = outs.every((o) => strip(o) === strip(out));

    const refTables = new Map(ref.nodes.map((n) => [String(n.data.name), n]));
    const recTables = new Map(out.tables.map((t) => [t.name, t]));
    const tableDiffs: string[] = [];
    for (const [n, node] of refTables) {
      const r = recTables.get(n);
      if (!r) tableDiffs.push(`table ${n}: adapter only`);
      else if (r.exportName !== node.data.exportName)
        tableDiffs.push(`table ${n}: exportName ${r.exportName} vs ${String(node.data.exportName)}`);
      else if (r.file !== node.data.file || r.line !== node.data.line)
        tableDiffs.push(
          `table ${n}: at ${r.file}:${r.line} vs ${String(node.data.file)}:${String(node.data.line)}`,
        );
    }
    for (const n of recTables.keys()) if (!refTables.has(n)) tableDiffs.push(`table ${n}: recipe only`);

    // Edges: (src, table, kind) with count, evidence and confidence, as the adapter writes them.
    interface E {
      count: number;
      evidence: string[];
      confidence: string;
    }
    const recEdges = new Map<string, E>();
    for (const a of out.accesses) {
      const k = `${a.src} -> table:${a.table} ${a.kind}s`;
      const e = recEdges.get(k) ?? { count: 0, evidence: [], confidence: "high" };
      e.count++;
      if (!e.evidence.includes(`${a.file}:${a.line}`)) e.evidence.push(`${a.file}:${a.line}`);
      if (a.confidence === "low") e.confidence = "low";
      recEdges.set(k, e);
    }
    const refEdges = new Map<string, E>();
    for (const e of ref.edges)
      refEdges.set(`${e.src} -> ${e.dst} ${e.kind}`, {
        count: Number((e as { count?: number }).count ?? 1),
        evidence: [...((e as { evidence?: string[] }).evidence ?? [])].sort(),
        confidence: e.confidence,
      });
    const edgeDiffs: string[] = [];
    for (const [k, e] of refEdges) {
      const r = recEdges.get(k);
      if (!r) {
        edgeDiffs.push(`${k}: adapter only`);
        continue;
      }
      r.evidence.sort();
      if (r.count !== e.count) edgeDiffs.push(`${k}: count ${r.count} vs ${e.count}`);
      if (JSON.stringify(r.evidence) !== JSON.stringify(e.evidence))
        edgeDiffs.push(`${k}: evidence ${r.evidence.join(",")} vs ${e.evidence.join(",")}`);
      if (r.confidence !== e.confidence)
        edgeDiffs.push(`${k}: confidence ${r.confidence} vs ${e.confidence}`);
    }
    for (const k of recEdges.keys()) if (!refEdges.has(k)) edgeDiffs.push(`${k}: recipe only`);

    const count = (m: Map<string, E>, kind: string) =>
      [...m.keys()].filter((k) => k.endsWith(` ${kind}`)).length;
    fixtures[fx] = {
      tables: { recipe: recTables.size, adapter: refTables.size },
      reads: { recipe: count(recEdges, "reads"), adapter: count(refEdges, "reads") },
      writes: { recipe: count(recEdges, "writes"), adapter: count(refEdges, "writes") },
      differences: [...tableDiffs, ...edgeDiffs].sort(),
      exact: tableDiffs.length + edgeDiffs.length === 0,
      deterministic,
      adapterFieldsNotProduced: ["columns", "dialect", "symbol (table node)"],
    };
    console.log(
      `drizzle on ${fx}: tables ${recTables.size}/${refTables.size} reads ${count(recEdges, "reads")}/${count(refEdges, "reads")} writes ${count(recEdges, "writes")}/${count(refEdges, "writes")} diffs ${tableDiffs.length + edgeDiffs.length}`,
    );
    for (const d of [...tableDiffs, ...edgeDiffs]) console.log(`   ${d}`);
  }
  results.drizzleFixtures = fixtures;
}

results.setup = {
  node: process.version,
  platform: `${os.platform()} ${os.arch()}`,
  cpu: os.cpus()[0]?.model,
  astGrepNapi: JSON.parse(readFileSync(path.join(here, "package.json"), "utf8")).dependencies,
  bar: { recall: 0.9, precision: 0.95 },
  recallPrecisionDefinition:
    "per stack: the lowest recall and the lowest precision over the three kinds table, read, write",
};
if (only.length === 0)
  writeFileSync(path.join(here, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log("median ms per stack:", JSON.stringify(timings));

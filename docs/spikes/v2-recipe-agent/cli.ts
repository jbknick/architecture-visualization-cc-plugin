// Dry-run and index commands of the recipe agent prototype.
//   tsx cli.ts dry-run [--root <dir>] [--recipe <file>]   validate examples, print match counts and samples per rule
//   tsx cli.ts index   [--root <dir>] [--recipe <file>] [--out <file>] [--dump <file>]
//                                                          run an accepted recipe; write the engine output and the dump
// Defaults: root = current directory, recipe = <root>/.gantry/recipe.json. Exit 0 accepted, 1 rejected, 2 usage.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkExamples, structureProblems, toDump } from "./check.ts";
import { type Recipe, runRecipe } from "./engine.ts";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const root = path.resolve(flag("--root") ?? ".");
const recipeFile = path.resolve(flag("--recipe") ?? path.join(root, ".gantry", "recipe.json"));

if (cmd !== "dry-run" && cmd !== "index") {
  console.error("usage: cli.ts dry-run|index [--root dir] [--recipe file] [--out file] [--dump file]");
  process.exit(2);
}

let recipe: Recipe;
try {
  recipe = JSON.parse(readFileSync(recipeFile, "utf8")) as Recipe;
} catch (err) {
  console.log(`REJECTED: cannot read recipe ${recipeFile}: ${(err as Error).message}`);
  process.exit(1);
}
const problems = structureProblems(recipe);
if (problems.length) {
  console.log(`REJECTED: ${problems.length} structure problem(s)`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}

const examples = checkExamples(recipe);
const failed = examples.filter((e) => !e.ok);
const out = runRecipe(root, recipe);

if (cmd === "dry-run") {
  console.log(`recipe ${recipe.name}: ${recipe.rules.length} rules, ${out.files} files scanned`);
  console.log("\nEXAMPLES");
  for (const r of recipe.rules) {
    const mine = examples.filter((e) => e.rule === r.id);
    const bad = mine.filter((e) => !e.ok);
    console.log(`  ${r.id}: ${mine.length - bad.length}/${mine.length} ok`);
    for (const b of bad)
      console.log(
        `    FAIL ${b.kind} #${b.index} ${b.kind === "match" ? "did not match" : "matched"}: ${b.snippet.slice(0, 160)}`,
      );
  }
  console.log("\nRULES (matches in this repo, first samples)");
  for (const r of recipe.rules) {
    console.log(`  ${r.id}: ${out.matches[r.id] ?? 0} match(es)`);
    for (const s of out.samples[r.id] ?? []) console.log(`    ${s.file}:${s.line}  ${s.text}`);
  }
  if (out.zeroMatchRules.length)
    console.log(
      `\nWARNING zero matches in this repo (valid only if the construct is not used yet): ${out.zeroMatchRules.join(", ")}`,
    );
  const list = (title: string, xs: string[]) => {
    console.log(`\n${title}: ${xs.length}`);
    for (const x of xs.slice(0, 60)) console.log(`  ${x}`);
    if (xs.length > 60) console.log(`  ... ${xs.length - 60} more`);
  };
  list(
    "ENDPOINTS",
    out.endpoints.map((e) => `${e.method} ${e.path}  (${e.file}:${e.line} ${e.rule})`),
  );
  list(
    "ROUTES",
    out.routes.map((r) => `${r.urlPath}  (${r.file})`),
  );
  list(
    "TABLES",
    out.tables.map((t) => `${t.name}  (${t.file}:${t.line} ${t.rule})`),
  );
  if (out.unresolved.length) {
    console.log(`\nUNRESOLVED (registration found, path not static): ${out.unresolved.length}`);
    for (const u of out.unresolved.slice(0, 20)) console.log(`  ${u.file}:${u.line} ${u.rule}: ${u.reason}`);
  }
  if (out.droppedNotRouter)
    console.log(`\nDROPPED: ${out.droppedNotRouter} match(es) whose receiver is not a declared router`);
  console.log(
    failed.length ? `\nREJECTED: ${failed.length} example failure(s)` : "\nACCEPTED: all examples pass",
  );
  process.exit(failed.length ? 1 : 0);
}

// index
if (failed.length) {
  console.log(`REJECTED: ${failed.length} example failure(s); run dry-run`);
  process.exit(1);
}
const o = flag("--out");
const d = flag("--dump");
if (o) writeFileSync(o, `${JSON.stringify(out, null, 2)}\n`);
if (d) writeFileSync(d, `${JSON.stringify(toDump(out), null, 2)}\n`);
console.log(
  `index ok: ${out.endpoints.length} endpoints, ${out.routes.length} routes, ${out.tables.length} tables, ${out.zeroMatchRules.length} zero-match rule(s)`,
);

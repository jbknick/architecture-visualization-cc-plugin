// On-request re-run (step 7 of the spike). Per repetition: copy fixtures/pnpm-turbo, let the agent write its recipe,
// add an Express app (5 routes on a router mounted under /api) and a Prisma schema (2 models), compute the gaps the
// recipe does not cover, give them to a second agent run with the current recipe, and measure new nodes found and
// existing nodes lost (must be 0).
//   pnpm tsx docs/spikes/v2-recipe-agent/rerun.ts [--reps 3] [--scratch dir]
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkExamples, toDump } from "./check.ts";
import { type Recipe, type RecipeOutput, runRecipe } from "./engine.ts";
import { detectGaps, type Gap } from "./gaps.ts";
import { agentFile, claudeRun } from "./run.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const tsx = path.join(repoRoot, "node_modules/.bin/tsx");
const dryRun = `${tsx} ${path.join(here, "cli.ts")} dry-run`;
const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const REPS = Number(arg("--reps") ?? 3);
const scratch = path.resolve(arg("--scratch") ?? path.join(repoRoot, "..", "recipe-agent-rerun"));

const initMessage = `Write the recipe for this repository (your working directory). Dry-run command: ${dryRun} --root . --recipe .gantry/recipe.json . Write the recipe to .gantry/recipe.json with the Write tool.`;
const onRequestMessage = `On-request re-run. This repository already has a recipe at .gantry/recipe.json, written by an earlier run. The index found code that recipe does not cover and listed it in .gantry/gaps.json (three kinds: dependency, route-site, sql-site). Read the gaps and the code at each, then extend .gantry/recipe.json with rules for the routes, endpoints and tables the gaps reveal. Keep every existing rule that still works: do not remove or weaken a rule unless the dry-run shows it is wrong, because nodes the old recipe found must still be found. A gap that is not a route, endpoint or table (an unrelated dependency, a call that is not a registration) is dismissed: add it under a top-level "dismissed" key of the recipe, {"dependencies": [{"name": "...", "reason": "..."}], "sites": [{"file": "...", "reason": "..."}]}. Every new rule needs examples. Dry-run command: ${dryRun} --root . --recipe .gantry/recipe.json . Edit .gantry/recipe.json and finish with a short message.`;

const EXPRESS_PKG = `{
  "name": "@acme/express",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": { "@prisma/client": "^5.0.0", "express": "^4.19.0" }
}
`;
const EXPRESS_SRC = `import { PrismaClient } from "@prisma/client";
import express from "express";

const prisma = new PrismaClient();
const app = express();
const api = express.Router();

api.get("/items", async (_req, res) => {
  res.json(await prisma.item.findMany());
});
api.get("/items/:id", async (req, res) => {
  res.json(await prisma.item.findUnique({ where: { id: Number(req.params.id) } }));
});
api.post("/items", async (req, res) => {
  res.status(201).json(await prisma.item.create({ data: req.body }));
});
api.delete("/items/:id", async (req, res) => {
  await prisma.item.delete({ where: { id: Number(req.params.id) } });
  res.status(204).end();
});
api.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", api);
app.listen(3000);
`;
const PRISMA = `datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model Item {
  id   Int    @id @default(autoincrement())
  name String
  tags Tag[]
}

model Tag {
  id     Int    @id @default(autoincrement())
  label  String
  item   Item   @relation(fields: [itemId], references: [id])
  itemId Int
}
`;
const TRUTH_NEW = [
  "endpoint GET /api/items",
  "endpoint GET /api/items/:id",
  "endpoint POST /api/items",
  "endpoint DELETE /api/items/:id",
  "endpoint GET /api/health",
  "table item",
  "table tag",
];

const nodeKeys = (o: RecipeOutput): string[] =>
  toDump(o)
    .adapterNodes.map((n) =>
      n.kind === "route"
        ? `route ${n.data.urlPath}`
        : n.kind === "endpoint"
          ? `endpoint ${n.data.method} ${n.data.path}`
          : `table ${String(n.data.name).toLowerCase()}`,
    )
    .sort();
const normKey = (k: string) => k.replace(/\/\$\w+|\/:\w+|\/\[\w+\]/g, "/:param");

const results: unknown[] = [];
for (let rep = 1; rep <= REPS; rep++) {
  const dir = path.join(here, "runs-rerun", `rep${rep}`);
  const resultFile = path.join(dir, "result.json");
  if (existsSync(resultFile)) {
    results.push(JSON.parse(readFileSync(resultFile, "utf8")));
    continue;
  }
  mkdirSync(dir, { recursive: true });
  const work = path.join(scratch, `rep${rep}`, "repo");
  rmSync(path.join(scratch, `rep${rep}`), { recursive: true, force: true });
  cpSync(path.join(repoRoot, "fixtures/pnpm-turbo"), work, {
    recursive: true,
    filter: (s) => !/(^|\/)(node_modules|\.git|\.claude)$/.test(s),
  });
  mkdirSync(path.join(work, ".claude", "agents"), { recursive: true });
  mkdirSync(path.join(work, ".gantry"), { recursive: true });
  writeFileSync(path.join(work, ".claude", "agents", "recipe-agent.md"), agentFile(dryRun));
  const transcripts = path.join(scratch, `rep${rep}`);
  const rec: Record<string, unknown> = { rep };
  const run1 = await claudeRun(work, initMessage, dryRun, path.join(transcripts, "run1.jsonl"));
  const recipeFile = path.join(work, ".gantry", "recipe.json");
  rec.run1 = { ...run1, final: undefined };
  if (!existsSync(recipeFile)) {
    rec.failed = `first run wrote no recipe: ${run1.error ?? run1.final.slice(0, 200)}`;
    writeFileSync(resultFile, `${JSON.stringify(rec, null, 2)}\n`);
    results.push(rec);
    continue;
  }
  const recipe1 = JSON.parse(readFileSync(recipeFile, "utf8")) as Recipe;
  writeFileSync(path.join(dir, "recipe1.json"), readFileSync(recipeFile));
  const before = runRecipe(work, recipe1);
  const beforeKeys = nodeKeys(before);
  rec.nodesBefore = beforeKeys.length;
  rec.exampleFailuresRun1 = checkExamples(recipe1).filter((e) => !e.ok).length;

  // add the Express app and the Prisma schema
  mkdirSync(path.join(work, "apps/express/src"), { recursive: true });
  mkdirSync(path.join(work, "apps/express/prisma"), { recursive: true });
  writeFileSync(path.join(work, "apps/express/package.json"), EXPRESS_PKG);
  writeFileSync(path.join(work, "apps/express/src/index.ts"), EXPRESS_SRC);
  writeFileSync(path.join(work, "apps/express/prisma/schema.prisma"), PRISMA);

  const outAfterAdd = runRecipe(work, recipe1);
  const gaps1: Gap[] = detectGaps(work, recipe1, outAfterAdd);
  writeFileSync(path.join(work, ".gantry", "gaps.json"), `${JSON.stringify(gaps1, null, 2)}\n`);
  writeFileSync(path.join(dir, "gaps1.json"), `${JSON.stringify(gaps1, null, 2)}\n`);
  const nodesNoRerun = nodeKeys(outAfterAdd);

  const run2 = await claudeRun(work, onRequestMessage, dryRun, path.join(transcripts, "run2.jsonl"));
  rec.run2 = { ...run2, final: undefined };
  writeFileSync(path.join(dir, "final2.txt"), `${run2.final}\n`);
  let recipe2: Recipe | null = null;
  try {
    recipe2 = JSON.parse(readFileSync(recipeFile, "utf8")) as Recipe;
    writeFileSync(path.join(dir, "recipe2.json"), readFileSync(recipeFile));
  } catch (e) {
    rec.failed = `second run left an unreadable recipe: ${(e as Error).message}`;
  }
  if (recipe2) {
    const exFail = checkExamples(recipe2).filter((e) => !e.ok).length;
    rec.exampleFailuresRun2 = exFail;
    const after = runRecipe(work, recipe2);
    const afterKeys = nodeKeys(after);
    const afterSet = new Set(afterKeys.map(normKey));
    const beforeSet = new Set(beforeKeys.map(normKey));
    const lost = beforeKeys.filter((k) => !afterSet.has(normKey(k)));
    const added = afterKeys.filter((k) => !beforeSet.has(normKey(k)));
    const truth = new Set(TRUTH_NEW.map(normKey));
    const foundNew = [...new Set(added.map(normKey))].filter((k) => truth.has(k));
    const gaps2 = detectGaps(work, recipe2, after);
    writeFileSync(path.join(dir, "gaps2.json"), `${JSON.stringify(gaps2, null, 2)}\n`);
    const count = (g: Gap[], t: Gap["type"]) => g.filter((x) => x.type === t).length;
    Object.assign(rec, {
      nodesBeforeAfterAddWithoutRerun: nodesNoRerun.length,
      nodesAfter: afterKeys.length,
      added: added.length,
      addedKeys: added,
      lost: lost.length,
      lostKeys: lost,
      newExpected: TRUTH_NEW.length,
      newFound: foundNew.length,
      newMissed: [...truth].filter((k) => !foundNew.includes(k)),
      gapsGiven: {
        total: gaps1.length,
        dependency: count(gaps1, "dependency"),
        "route-site": count(gaps1, "route-site"),
        "sql-site": count(gaps1, "sql-site"),
      },
      gapsLeft: {
        total: gaps2.length,
        dependency: count(gaps2, "dependency"),
        "route-site": count(gaps2, "route-site"),
        "sql-site": count(gaps2, "sql-site"),
      },
      zeroMatchRules: after.zeroMatchRules,
    });
  }
  writeFileSync(resultFile, `${JSON.stringify(rec, null, 2)}\n`);
  console.log(
    `rep${rep}: lost=${rec.lost} newFound=${rec.newFound}/${rec.newExpected} gaps ${JSON.stringify(rec.gapsGiven)} -> ${JSON.stringify(rec.gapsLeft)}`,
  );
  results.push(rec);
}
writeFileSync(path.join(here, "rerun.json"), `${JSON.stringify({ reps: results }, null, 2)}\n`);
void execFileSync;

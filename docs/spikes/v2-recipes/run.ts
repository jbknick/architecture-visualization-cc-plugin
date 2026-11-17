// Spike: agent-written ast-grep recipes vs the built-in adapters and hand labels.
// Usage (from the repo root): pnpm tsx docs/spikes/v2-recipes/run.ts [--scratch /private/tmp/claude-501/gantry-spikes]
// The public repos must be cloned under --scratch at the commits recorded in labels/*.json.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mapRouteFile,
  parentRouteId,
  urlPathOfRouteId,
} from "../../../packages/core/src/adapters/tanstack-routes.js";
import { type Helper, type Recipe, type RecipeOutput, runRecipe, type TanstackHelper } from "./engine.js";
import { type RefGraph, referenceGraph } from "./reference.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const argScratch = process.argv.indexOf("--scratch");
const scratch =
  argScratch > 0 ? (process.argv[argScratch + 1] as string) : "/private/tmp/claude-501/gantry-spikes";

const recipe = (name: string): Recipe =>
  JSON.parse(readFileSync(path.join(here, "recipes", `${name}.json`), "utf8")) as Recipe;
const rulesOnly = (r: Recipe): Recipe => ({ ...r, helpers: [] as Helper[] });
const tanstack: TanstackHelper = { mapRouteFile, urlPathOfRouteId, parentRouteId };

interface Score {
  expected: number;
  found: number;
  tp: number;
  precision: number;
  recall: number;
  missing: string[];
  extra: string[];
}
function score(expected: string[], found: string[]): Score {
  const e = new Set(expected);
  const f = new Set(found);
  const tp = [...f].filter((x) => e.has(x)).length;
  return {
    expected: e.size,
    found: f.size,
    tp,
    precision: f.size === 0 ? 0 : tp / f.size,
    recall: e.size === 0 ? 1 : tp / e.size,
    missing: [...e].filter((x) => !f.has(x)).sort(),
    extra: [...f].filter((x) => !e.has(x)).sort(),
  };
}

const strip = (o: RecipeOutput) => JSON.stringify({ ...o, ms: undefined });
function timed(
  root: string,
  r: Recipe,
  runs = 3,
): { out: RecipeOutput; medianMs: number; deterministic: boolean } {
  const outs: RecipeOutput[] = [];
  for (let i = 0; i < runs; i++) outs.push(runRecipe(root, r, tanstack));
  const ms = outs.map((o) => o.ms.total).sort((a, b) => a - b);
  const first = outs[0] as RecipeOutput;
  return {
    out: first,
    medianMs: Math.round((ms[Math.floor(ms.length / 2)] as number) * 10) / 10,
    deterministic: outs.every((o) => strip(o) === strip(first)),
  };
}

const results: Record<string, unknown> = {};
const fmt = (s: Score) =>
  `P ${(s.precision * 100).toFixed(0)}% R ${(s.recall * 100).toFixed(0)}% (${s.tp}/${s.expected}, found ${s.found})` +
  (s.missing.length ? `\n      missing: ${s.missing.join(" | ")}` : "") +
  (s.extra.length ? `\n      extra:   ${s.extra.join(" | ")}` : "");

// --- 1 and 2: fixtures vs the adapters ----------------------------------------------------------------------
for (const fx of ["pnpm-turbo", "adapters"]) {
  const root = path.join(repoRoot, "fixtures", fx);
  const ref: RefGraph = await referenceGraph(root);
  const refRoutes = ref.nodes.filter((n) => n.kind === "route");
  const refEps = ref.nodes.filter(
    (n) => n.kind === "endpoint" && (n.data as { adapter?: string }).adapter === "hono",
  );
  const refMw = ref.nodes.filter((n) => n.kind === "middleware");
  const refHandles = ref.edges
    .filter((e) => e.kind === "handles" && refEps.some((n) => n.id === e.src))
    .map((e) => `${e.src} -> ${e.dst}`);
  const refServes = ref.edges
    .filter((e) => e.kind === "serves" && e.src.startsWith("route:"))
    .map((e) => `${e.src} -> ${e.dst}`);
  const refContains = ref.edges.filter((e) => e.kind === "contains").map((e) => `${e.src} -> ${e.dst}`);
  const refUrl = refRoutes.map((n) => `${n.id} = ${(n.data as { urlPath: string }).urlPath}`);

  for (const [label, r] of [
    ["recipe+helpers", recipe("tanstack-router")],
    ["rules-only", rulesOnly(recipe("tanstack-router"))],
  ] as const) {
    const t = timed(root, r);
    const o = t.out;
    const s = {
      routes: score(
        refRoutes.map((n) => n.id),
        o.routes.map((x) => x.id),
      ),
      urlPath: score(
        refUrl,
        o.routes.map((x) => `${x.id} = ${x.urlPath}`),
      ),
      serves: score(
        refServes,
        o.routes.filter((x) => x.componentSymbol).map((x) => `${x.id} -> ${x.componentSymbol}`),
      ),
      contains: score(
        refContains,
        o.routes.filter((x) => x.parent).map((x) => `${x.parent} -> ${x.id}`),
      ),
    };
    results[`tanstack/${fx}/${label}`] = {
      ...s,
      ms: t.medianMs,
      deterministic: t.deterministic,
      matches: o.matches,
    };
    console.log(
      `\n[tanstack ${fx} ${label}] ${t.medianMs} ms, deterministic=${t.deterministic}, matches=${JSON.stringify(o.matches)}`,
    );
    for (const [k, v] of Object.entries(s)) console.log(`  ${k.padEnd(9)} ${fmt(v)}`);
  }

  for (const [label, r] of [
    ["recipe+helpers", recipe("hono")],
    ["rules-only", rulesOnly(recipe("hono"))],
  ] as const) {
    const t = timed(root, r);
    const o = t.out;
    const s = {
      endpoints: score(
        refEps.map((n) => n.id),
        o.endpoints.map((x) => x.id),
      ),
      handles: score(
        refHandles,
        o.endpoints.filter((x) => x.handlerSymbol).map((x) => `${x.id} -> ${x.handlerSymbol}`),
      ),
      middleware: score(
        refMw.map((n) => n.id),
        o.middleware.map((x) => x.id),
      ),
    };
    results[`hono/${fx}/${label}`] = {
      ...s,
      ms: t.medianMs,
      deterministic: t.deterministic,
      matches: o.matches,
    };
    console.log(
      `\n[hono ${fx} ${label}] ${t.medianMs} ms, deterministic=${t.deterministic}, matches=${JSON.stringify(o.matches)}`,
    );
    for (const [k, v] of Object.entries(s)) console.log(`  ${k.padEnd(10)} ${fmt(v)}`);
  }
}

// --- 3: Express on a public repo vs hand labels --------------------------------------------------------------
const norm = (id: string) => {
  const m = /^ep:[^:]*:(\S+) (.*)$/.exec(id) ?? /^ep:.*?:(\S+) (.*)$/.exec(id);
  if (!m) return id;
  const p = (m[2] as string).replace(/\/+$/, "") || "/";
  return `${m[1]} ${p}`;
};
{
  const labels = JSON.parse(readFileSync(path.join(here, "labels/express-realworld.json"), "utf8")) as {
    endpoints: string[];
  };
  const root = path.join(scratch, "node-express-realworld-example-app");
  for (const [label, r] of [
    ["recipe+helpers", recipe("express")],
    ["rules-only", rulesOnly(recipe("express"))],
  ] as const) {
    const t = timed(root, r);
    const s = score(
      labels.endpoints,
      t.out.endpoints.map((e) => norm(e.id)),
    );
    results[`express/realworld/${label}`] = {
      endpoints: s,
      ms: t.medianMs,
      deterministic: t.deterministic,
      files: t.out.files,
      matches: t.out.matches,
    };
    console.log(
      `\n[express realworld ${label}] ${t.medianMs} ms, ${t.out.files} files, deterministic=${t.deterministic}, matches=${JSON.stringify(t.out.matches)}`,
    );
    console.log(`  endpoints  ${fmt(s)}`);
  }
}

// --- 4: chi and gin on public code vs hand labels ------------------------------------------------------------
{
  const labels = JSON.parse(readFileSync(path.join(here, "labels/go.json"), "utf8")) as {
    scenarios: Record<string, { recipe: string; endpoints: string[] }>;
  };
  const totals: Record<string, { tp: number; e: number; f: number }> = {};
  for (const [dir, sc] of Object.entries(labels.scenarios)) {
    const root = path.join(scratch, dir);
    for (const [label, r] of [
      ["recipe+helpers", recipe(sc.recipe)],
      ["rules-only", rulesOnly(recipe(sc.recipe))],
    ] as const) {
      const t = timed(root, r);
      const s = score(
        sc.endpoints,
        t.out.endpoints.map((e) => norm(e.id)),
      );
      const k = `${sc.recipe}/${label}`;
      const tot = totals[k] ?? { tp: 0, e: 0, f: 0 };
      tot.tp += s.tp;
      tot.e += s.expected;
      tot.f += s.found;
      totals[k] = tot;
      results[`${sc.recipe}/${dir}/${label}`] = {
        endpoints: s,
        ms: t.medianMs,
        deterministic: t.deterministic,
        matches: t.out.matches,
      };
      console.log(
        `\n[${sc.recipe} ${dir} ${label}] ${t.medianMs} ms, deterministic=${t.deterministic}, matches=${JSON.stringify(t.out.matches)}`,
      );
      console.log(`  endpoints  ${fmt(s)}`);
    }
  }
  console.log("\nGo totals:");
  for (const [k, v] of Object.entries(totals)) {
    console.log(
      `  ${k}: P ${((v.tp / v.f) * 100).toFixed(0)}% R ${((v.tp / v.e) * 100).toFixed(0)}% (${v.tp}/${v.e}, found ${v.f})`,
    );
  }
  results.goTotals = totals;
}

// --- timing on whole repos (no labels; counts only) ----------------------------------------------------------
for (const [dir, name] of [
  ["chi", "chi"],
  ["examples", "gin"],
] as const) {
  const t = timed(path.join(scratch, dir), recipe(name));
  results[`whole/${dir}`] = {
    files: t.out.files,
    endpoints: t.out.endpoints.length,
    ms: t.medianMs,
    parseMs: Math.round(t.out.ms.parse),
    deterministic: t.deterministic,
    matches: t.out.matches,
  };
  console.log(
    `\n[whole ${dir} with ${name}] ${t.out.files} qualifying files, ${t.out.endpoints.length} endpoints, ${t.medianMs} ms (parse ${Math.round(t.out.ms.parse)} ms), deterministic=${t.deterministic}`,
  );
}

// --- held-out: every registration outside the tuning examples, labelled after the recipes were written -------
for (const [dir, name, labelFile, exclude] of [
  ["chi", "chi", "chi-heldout", /^_examples\/(?:rest|versions|todos-resource)$/],
  ["examples", "gin", "gin-heldout", /^(?:group-routes|versioning)(?:\/|$)/],
] as const) {
  const labels = JSON.parse(readFileSync(path.join(here, "labels", `${labelFile}.json`), "utf8")) as {
    endpoints: string[];
  };
  const t = timed(path.join(scratch, dir), recipe(name));
  const found = t.out.endpoints.filter((e) => !exclude.test(e.ws)).map((e) => `${e.ws} ${norm(e.id)}`);
  const s = score(labels.endpoints, found);
  results[`heldout/${dir}`] = {
    endpoints: s,
    unresolved: t.out.unresolved,
    droppedNotRouter: t.out.droppedNotRouter,
  };
  console.log(
    `\n[held-out ${dir} with ${name}] unresolved=${t.out.unresolved.length} droppedNotRouter=${t.out.droppedNotRouter}`,
  );
  console.log(`  endpoints  ${fmt(s)}`);
  for (const u of t.out.unresolved) console.log(`  unresolved ${u.file}:${u.line} ${u.rule}: ${u.reason}`);
}

writeFileSync(path.join(here, "results.json"), `${JSON.stringify(results, null, 2)}\n`);

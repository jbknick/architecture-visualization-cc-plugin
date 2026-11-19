// Deterministic gap detection for the on-request re-run: the three gap types of the plan (milestone M9, "Gaps tell
// you when to ask"), approximated for the spike. No model call.
//   dependency: a runtime dependency of a workspace package.json that the recipe has not classified
//   route-site: a call `x.m("/path", ...)` that no emitted endpoint or route comes from
//   sql-site: a SQL string in code, or a .sql / .prisma file, that no emitted table comes from
// A recipe classifies a dependency by naming it in `frameworks[].name`, `when.dependency`, or `dismissed.dependencies`;
// it dismisses a site with `dismissed.sites` (file, reason).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import type { Recipe, RecipeOutput } from "./engine.ts";

export interface Gap {
  type: "dependency" | "route-site" | "sql-site";
  key: string;
  file: string;
  line?: number;
}
type WithDismissed = Recipe & {
  dismissed?: { dependencies?: { name: string }[]; sites?: { file: string }[] };
};

const SKIP = new Set(["node_modules", ".git", "dist", "vendor"]);
const walk = (root: string, f: (rel: string) => void, dir = root) => {
  for (const e of readdirSync(dir).sort()) {
    if (SKIP.has(e) || e.startsWith(".")) continue;
    const abs = path.join(dir, e);
    if (statSync(abs).isDirectory()) walk(root, f, abs);
    else f(path.relative(root, abs).split(path.sep).join("/"));
  }
};

const SQL_RE = /\b(?:select\s[\s\S]{1,200}?\sfrom\s|insert\s+into\s|update\s+\w+\s+set\s|delete\s+from\s)/i;

export function detectGaps(root: string, recipe: Recipe | null, out: RecipeOutput | null): Gap[] {
  const r = recipe as WithDismissed | null;
  const classified = new Set<string>([
    ...(r?.frameworks ?? []).map((f) => f.name),
    ...(r?.when?.dependency ?? []),
    ...(r?.dismissed?.dependencies ?? []).map((d) => d.name),
  ]);
  const dismissedFiles = new Set((r?.dismissed?.sites ?? []).map((s) => s.file));
  const covered = new Set<string>([
    ...(out?.endpoints ?? []).map((e) => `${e.file}:${e.line}`),
    ...(out?.routes ?? []).map((x) => `${x.file}`),
  ]);
  const coveredTableFiles = new Set((out?.tables ?? []).map((t) => t.file));
  const files: string[] = [];
  walk(root, (rel) => files.push(rel));
  const workspaceNames = new Set<string>();
  for (const f of files)
    if (f.endsWith("package.json")) {
      try {
        const n = (JSON.parse(readFileSync(path.join(root, f), "utf8")) as { name?: string }).name;
        if (n) workspaceNames.add(n);
      } catch {}
    }
  const gaps: Gap[] = [];
  for (const f of files) {
    const abs = path.join(root, f);
    if (f.endsWith("package.json")) {
      let j: { dependencies?: Record<string, string> };
      try {
        j = JSON.parse(readFileSync(abs, "utf8"));
      } catch {
        continue;
      }
      for (const dep of Object.keys(j.dependencies ?? {}).sort())
        if (!classified.has(dep) && !workspaceNames.has(dep) && !dep.startsWith("@types/"))
          gaps.push({ type: "dependency", key: dep, file: f });
    } else if (f.endsWith(".sql") || f.endsWith(".prisma")) {
      if (!coveredTableFiles.has(f) && !dismissedFiles.has(f))
        gaps.push({ type: "sql-site", key: f, file: f });
    } else if (/\.(?:ts|tsx|mts)$/.test(f) && !/\.d\.ts$|\.gen\.ts$/.test(f)) {
      const src = readFileSync(abs, "utf8");
      const root0 = parse(f.endsWith("x") ? Lang.Tsx : Lang.TypeScript, src).root();
      if (!dismissedFiles.has(f)) {
        for (const n of root0.findAll({ rule: { pattern: "$O.$M($P, $$$A)" } })) {
          const p = n.getMatch("P");
          const o = n.getMatch("O");
          if (!p || !o || o.kind() !== "identifier") continue;
          if (p.kind() !== "string" || !p.text().slice(1, -1).startsWith("/")) continue;
          const line = n.range().start.line + 1;
          if (!covered.has(`${f}:${line}`))
            gaps.push({ type: "route-site", key: `${o.text()}.${n.getMatch("M")?.text()}`, file: f, line });
        }
        for (const n of root0.findAll({ rule: { any: [{ kind: "string" }, { kind: "template_string" }] } })) {
          if (SQL_RE.test(n.text()) && !coveredTableFiles.has(f))
            gaps.push({
              type: "sql-site",
              key: `${f}:${n.range().start.line + 1}`,
              file: f,
              line: n.range().start.line + 1,
            });
        }
      }
    }
  }
  return gaps;
}

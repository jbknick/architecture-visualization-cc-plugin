// Recipe acceptance checks: structure, then each rule's examples (snippets that must and must not match).
import { Lang, parse } from "@ast-grep/napi";
import type { Recipe, RecipeOutput } from "./engine.ts";

const EMITS = new Set(["router", "mount", "endpoint", "middleware", "route", "table"]);
const HELPERS = new Set([
  "resolve-names",
  "const-strings",
  "mount-graph",
  "call-return",
  "param-flow",
  "tanstack-file-routes",
]);

/** Structural problems of a parsed recipe (empty when fine). */
export function structureProblems(r: unknown): string[] {
  const out: string[] = [];
  const x = r as Partial<Recipe> | null;
  if (!x || typeof x !== "object") return ["recipe is not an object"];
  if (typeof x.name !== "string") out.push("name must be a string");
  if (!Array.isArray(x.helpers)) out.push("helpers must be an array");
  else for (const h of x.helpers) if (!HELPERS.has(h)) out.push(`unknown helper ${h}`);
  if (!Array.isArray(x.rules)) return [...out, "rules must be an array"];
  const ids = new Set<string>();
  for (const [i, rule] of x.rules.entries()) {
    const at = `rules[${i}] (${rule?.id ?? "no id"})`;
    if (!rule?.id) out.push(`${at}: id is required`);
    else if (ids.has(rule.id)) out.push(`${at}: duplicate id`);
    else ids.add(rule.id);
    if (!["typescript", "go", "text"].includes(rule?.language))
      out.push(`${at}: language must be typescript, go or text`);
    if (!rule?.rule || typeof rule.rule !== "object") out.push(`${at}: rule is required`);
    if (!rule?.emit || !EMITS.has(rule.emit.kind))
      out.push(`${at}: emit.kind must be one of ${[...EMITS].join(", ")}`);
    if (rule?.language === "text" && (!rule.files || rule.files.length === 0))
      out.push(`${at}: a text rule needs files`);
    if (!rule?.examples || !Array.isArray(rule.examples.match) || !Array.isArray(rule.examples.noMatch))
      out.push(`${at}: examples {match: [...], noMatch: [...]} are required`);
    else if (rule.examples.match.length === 0)
      out.push(`${at}: at least one examples.match snippet is required`);
  }
  return out;
}

const parseSnippet = (language: string, snippet: string, tsx: boolean) => {
  if (language === "go") {
    const src = /^\s*package\s/.test(snippet) ? snippet : `package p\nfunc _() {\n${snippet}\n}\n`;
    return parse("go", src).root();
  }
  return parse(tsx ? Lang.Tsx : Lang.TypeScript, snippet).root();
};

export interface ExampleResult {
  rule: string;
  kind: "match" | "noMatch";
  index: number;
  ok: boolean;
  snippet: string;
}

/** Runs every rule's examples. A `match` snippet must produce at least one match; a `noMatch` snippet none. */
export function checkExamples(recipe: Recipe): ExampleResult[] {
  const out: ExampleResult[] = [];
  for (const rule of recipe.rules) {
    for (const kind of ["match", "noMatch"] as const) {
      for (const [index, snippet] of (rule.examples?.[kind] ?? []).entries()) {
        let n = 0;
        try {
          if (rule.language === "text") {
            n = rule.rule.regex ? [...snippet.matchAll(new RegExp(rule.rule.regex, "gm"))].length : 1;
          } else {
            const root = parseSnippet(rule.language, snippet, /<[A-Za-z]/.test(snippet));
            n = root.findAll({ rule: rule.rule, constraints: rule.constraints }).length;
          }
        } catch (err) {
          out.push({ rule: rule.id, kind, index, ok: false, snippet: `error: ${(err as Error).message}` });
          continue;
        }
        out.push({ rule: rule.id, kind, index, ok: kind === "match" ? n > 0 : n === 0, snippet });
      }
    }
  }
  return out;
}

/** The slice of an `index --dump` the scorer reads: files, edges and adapter nodes. */
export function toDump(o: RecipeOutput) {
  const node = (id: string, kind: string, data: Record<string, unknown>) => ({ id, kind, data });
  return {
    files: [],
    edges: [],
    adapterNodes: [
      ...o.routes.map((r) => node(r.id, "route", { urlPath: r.urlPath })),
      ...o.endpoints.map((e) => node(e.id, "endpoint", { method: e.method, path: e.path })),
      ...o.tables.map((t) => node(t.id, "table", { name: t.name })),
    ],
  };
}

import { createHash } from "node:crypto";
import { isBuiltin } from "node:module";
import type { AdapterFileContext, AdapterNode } from "../adapters/framework.js";
import { isNode, type Node, nodeArray, unwrap, visit } from "../parse/ast.js";
import type { EdgeRecord, WorkspaceRecord } from "../types.js";
import type { LoadedRecipe } from "./load.js";

/**
 * Recipe gaps (spec section 11): the code the committed recipe does not cover. Exactly three kinds, found by every
 * index run, with no model and no timestamps:
 *
 * - `dependency`: a dependency of a workspace manifest that the recipe's `dependencies` list does not name.
 * - `client_call`: a call to a URL that no endpoint answers (a `client_call` node whose reason is `no_endpoint`).
 * - `site`: a candidate route site (`X.m("/path", ...)` on something that comes from an imported package) or a
 *   candidate SQL site (a string that reads like a statement) where no node or edge evidence sits.
 */
export const GAP_KINDS = ["dependency", "client_call", "site"] as const;
export type GapKind = (typeof GAP_KINDS)[number];

export interface RecipeGap {
  /** `gap:dependency:<ws>:<name>`, `gap:client_call:<node id>`, `gap:site:<path>#<callee>(<arg>)` or `...#sql:<hash>`. */
  id: string;
  kind: GapKind;
  /** Repo-relative path. */
  file: string;
  /** 1-based line. */
  line: number;
  detail: string;
}

export interface GapInput {
  recipe: LoadedRecipe | null;
  workspaces: readonly WorkspaceRecord[];
  /** Every non-test TypeScript file of the read set. */
  files: readonly AdapterFileContext[];
  nodes: readonly AdapterNode[];
  edges: readonly EdgeRecord[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const SQL_START = /^\s*(select|insert|update|delete|with)\b/i;
const SQL_PART = /\b(from|into|set)\b/i;
const MAX_DETAIL = 80;

/** Whether text reads like a SQL statement: starts with a statement keyword and has FROM, INTO or SET. */
export function looksLikeSql(text: string): boolean {
  return SQL_START.test(text) && SQL_PART.test(text);
}

const oneLine = (s: string): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_DETAIL ? `${t.slice(0, MAX_DETAIL - 3)}...` : t;
};

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The identifier at the root of `a.b(c).d`, `new A()` or `await a()`; null for anything else. */
function rootName(expr: unknown): string | null {
  let cur = unwrap(expr);
  for (let i = 0; i < 32 && isNode(cur); i++) {
    if (cur.type === "Identifier") return cur.name as string;
    if (cur.type === "CallExpression" || cur.type === "NewExpression") cur = unwrap(cur.callee);
    else if (cur.type === "MemberExpression") cur = unwrap(cur.object);
    else if (cur.type === "AwaitExpression") cur = unwrap(cur.argument);
    else return null;
  }
  return null;
}

function stringOf(n: unknown): string | null {
  const v = unwrap(n);
  if (!isNode(v)) return null;
  if (v.type === "Literal" && typeof v.value === "string") return v.value;
  if (v.type === "TemplateLiteral" && nodeArray(v.expressions).length === 0) {
    const cooked = (nodeArray(v.quasis)[0]?.value as { cooked?: unknown } | undefined)?.cooked;
    return typeof cooked === "string" ? cooked : null;
  }
  return null;
}

/** Template text with `?` where an expression sits. */
function templateText(t: Node): string {
  const quasis = nodeArray(t.quasis).map((q) => {
    const v = q.value as { cooked?: unknown; raw?: unknown } | undefined;
    return typeof v?.cooked === "string" ? v.cooked : typeof v?.raw === "string" ? v.raw : "";
  });
  return quasis.join("?");
}

const isPackageSpecifier = (s: string): boolean =>
  s !== "" &&
  !s.startsWith(".") &&
  !s.startsWith("/") &&
  !s.startsWith("#") &&
  !s.startsWith("~") &&
  !s.startsWith("@/") &&
  !isBuiltin(s);

/** Places where an adapter put a node, or where an edge names evidence: path to the set of lines. */
function coveredLines(input: GapInput): Map<string, Set<number>> {
  const pathOf = new Map(input.files.map((f) => [f.fileId, f.path]));
  const out = new Map<string, Set<number>>();
  const add = (file: string | undefined, line: unknown): void => {
    if (file === undefined || typeof line !== "number") return;
    const s = out.get(file) ?? new Set<number>();
    out.set(file, s);
    s.add(line);
  };
  for (const n of input.nodes) {
    const file = typeof n.data.file === "string" ? n.data.file : pathOf.get(n.fileId);
    add(file, n.data.line);
    if (Array.isArray(n.data.lines)) for (const l of n.data.lines) add(file, l);
  }
  for (const e of input.edges) {
    for (const ev of e.evidence) {
      const i = ev.lastIndexOf(":");
      if (i > 0) add(ev.slice(0, i), Number(ev.slice(i + 1)));
    }
  }
  return out;
}

function siteGaps(input: GapInput): RecipeGap[] {
  const covered = coveredLines(input);
  const found: RecipeGap[] = [];
  for (const file of input.files) {
    // Cheap text checks first: most files hold neither a path argument nor a statement.
    const mayRoute = /\(\s*(["'`])\//.test(file.source);
    const maySql = /(select|insert|update|delete|with)\b/i.test(file.source);
    if (!mayRoute && !maySql) continue;
    const program = file.program();
    if (!program) continue;
    const imports = new Map<string, string>();
    for (const i of file.parsed?.imports ?? []) if (i.local !== "") imports.set(i.local, i.specifier);
    const origins = new Map<string, string>();
    const starts = lineStarts(file.source);
    const lines = covered.get(file.path);
    const hit = (from: number, to: number): boolean => {
      if (!lines) return false;
      for (let l = from; l <= to; l++) if (lines.has(l)) return true;
      return false;
    };
    const fromPackage = (name: string | null): boolean => {
      let cur = name;
      for (let i = 0; i < 8 && cur !== null; i++) {
        const spec = imports.get(cur);
        if (spec !== undefined) return isPackageSpecifier(spec);
        cur = origins.get(cur) ?? null;
      }
      return false;
    };
    visit(program, (n) => {
      if (n.type === "VariableDeclarator") {
        const id = unwrap(n.id);
        const root = rootName(n.init);
        if (isNode(id) && id.type === "Identifier" && root !== null && !origins.has(id.name as string)) {
          origins.set(id.name as string, root);
        }
      }
      return true;
    });
    const seen = new Set<string>();
    const push = (g: RecipeGap): void => {
      if (seen.has(g.id)) return;
      seen.add(g.id);
      found.push(g);
    };
    const sql = (node: Node, text: string): void => {
      if (!maySql || !looksLikeSql(text)) return;
      const from = lineAt(starts, node.start);
      const to = lineAt(starts, node.end);
      if (hit(from, to)) return;
      const hash = createHash("sha256").update(text).digest("hex").slice(0, 12);
      push({
        id: `gap:site:${file.path}#sql:${hash}`,
        kind: "site",
        file: file.path,
        line: from,
        detail: `SQL ${oneLine(text)}`,
      });
    };
    visit(program, (n) => {
      if (n.type === "CallExpression" && mayRoute) {
        const callee = unwrap(n.callee);
        const args = nodeArray(n.arguments);
        const first = args[0];
        if (isNode(callee) && callee.type === "MemberExpression" && callee.computed !== true && first) {
          const path = stringOf(first);
          if (path?.startsWith("/") && fromPackage(rootName(callee.object))) {
            const from = lineAt(starts, n.start);
            const to = lineAt(starts, first.end);
            if (!hit(from, to)) {
              const calleeText = oneLine(file.source.slice(callee.start, callee.end));
              const argText = oneLine(file.source.slice(first.start, first.end));
              push({
                id: `gap:site:${file.path}#${calleeText}(${argText})`,
                kind: "site",
                file: file.path,
                line: from,
                detail: `${calleeText}(${argText})`,
              });
            }
          }
        }
        return true;
      }
      if (n.type === "TaggedTemplateExpression") {
        const quasi = unwrap(n.quasi);
        if (isNode(quasi)) sql(n, templateText(quasi));
        // The tagged text is one candidate; its quasi is not a second one.
        return false;
      }
      if (n.type === "TemplateLiteral") sql(n, templateText(n));
      else if (n.type === "Literal" && typeof n.value === "string") sql(n, n.value);
      return true;
    });
  }
  return found;
}

/**
 * The open gaps of a tree, sorted by id. A repository with no readable
 * recipe has no gaps. An id the recipe lists under `dismissed` is not returned.
 */
export function computeGaps(input: GapInput): RecipeGap[] {
  const recipe = input.recipe?.recipe;
  if (!recipe) return [];
  const scoped = new Set(
    recipe.dependencies.filter((d) => d.workspace).map((d) => `${d.workspace}\0${d.name}`),
  );
  const unscoped = new Set(recipe.dependencies.filter((d) => !d.workspace).map((d) => d.name));
  const gaps: RecipeGap[] = [];
  for (const ws of input.workspaces) {
    if (ws.lang !== undefined && ws.lang !== "typescript") continue;
    const manifest = ws.dir === "." ? "package.json" : `${ws.dir}/package.json`;
    for (const dep of ws.deps) {
      if (unscoped.has(dep) || scoped.has(`${ws.name}\0${dep}`)) continue;
      gaps.push({
        id: `gap:dependency:${ws.id.startsWith("ws:") ? ws.id.slice(3) : ws.id}:${dep}`,
        kind: "dependency",
        file: manifest,
        line: 1,
        detail: `${dep} in ${ws.name} is not in the recipe dependencies`,
      });
    }
  }
  for (const n of input.nodes) {
    if (n.kind !== "client_call" || n.data.reason !== "no_endpoint") continue;
    const file = typeof n.data.file === "string" ? n.data.file : n.fileId;
    const line = typeof n.data.line === "number" ? n.data.line : 1;
    gaps.push({
      id: `gap:client_call:${n.id}`,
      kind: "client_call",
      file,
      line,
      detail: `${n.label} has no endpoint`,
    });
  }
  gaps.push(...siteGaps(input));
  const dismissed = new Set((recipe.dismissed ?? []).map((d) => d.id));
  const byId = new Map<string, RecipeGap>();
  for (const g of gaps.sort((a, b) => cmp(a.id, b.id))) {
    if (!dismissed.has(g.id) && !byId.has(g.id)) byId.set(g.id, g);
  }
  return [...byId.values()];
}

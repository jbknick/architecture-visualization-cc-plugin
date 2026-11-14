/**
 * Samples 200 function-like symbols from a private test-bed repo (Devprentice) and writes
 * `candidates.jsonl` (fact sheets only, no labels) to the git-ignored `evals/private/labelled/`.
 *
 * Usage: pnpm tsx evals/labelled/sample.ts [repoPath]
 * Env:   DEVPRENTICE_PATH (required unless passed as the first argument), LABELLED_SERVER_DIRS (required)
 *        LABELLED_OUT     (default <repo>/evals/private/labelled)
 *
 * Read-only on the target repo. Output must never be committed (spec section 1).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";

export const SEED = 42;
export const PROMPT_MAJOR = "p1";
export const STRATA = {
  component: 40,
  hook: 30,
  util: 50,
  server: 40,
  helper: 40,
} as const;
export type Stratum = keyof typeof STRATA;

const MAX_PER_FILE = 3;
const BODY_LIMIT = 1500;

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".output",
  ".turbo",
  ".vercel",
  ".wrangler",
  "coverage",
  ".git",
  ".storybook",
  "stories",
  "__tests__",
  "e2e",
  "tests",
  "artifacts",
  "worktrees",
  ".claude",
]);
const SENSITIVE = /^(\.env.*|.*\.pem|.*\.key|.*\.p12|id_rsa.*|\.npmrc|credentials.*|secrets.*|.*\.tfvars)$/i;
const SKIP_FILE = /(\.d\.ts|\.gen\.ts|\.test\.[cm]?tsx?|\.spec\.[cm]?tsx?|\.stories\.[cm]?tsx?)$/;
const PARSED = /\.(ts|tsx|mts|cts)$/;
// Server-side workspace dirs of the test bed, e.g. LABELLED_SERVER_DIRS="apps/api/,packages/db/" (kept out of the public repo).
const SERVER_DIRS = (process.env.LABELLED_SERVER_DIRS ?? "")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

export function isExcluded(rel: string): boolean {
  const parts = rel.split("/");
  const file = parts[parts.length - 1] ?? "";
  if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p))) return true;
  return SENSITIVE.test(file) || SKIP_FILE.test(file) || !PARSED.test(file);
}

function walk(root: string, dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    const rel = relative(root, abs).split(sep).join("/");
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, abs, out);
    } else if (e.isFile() && !isExcluded(rel)) out.push(rel);
  }
}

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes are walked structurally
type Node = any;

function visit(node: Node, fn: (n: Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const c of node) visit(c, fn);
    return;
  }
  if (typeof node.type === "string") fn(node);
  for (const k of Object.keys(node)) {
    if (k === "parent" || k === "loc") continue;
    const v = node[k];
    if (v && typeof v === "object") visit(v, fn);
  }
}

interface Candidate {
  path: string;
  name: string;
  exported: boolean;
  topLevel: boolean;
  isFn: boolean;
  fn: Node;
  /** node whose range is the symbol text */
  outer: Node;
  stmts: number;
  loc: number;
  hasJsx: boolean;
  serverStyle: boolean;
  src: string;
}

const isFnNode = (n: Node) =>
  n &&
  (n.type === "FunctionDeclaration" ||
    n.type === "FunctionExpression" ||
    n.type === "ArrowFunctionExpression");

function stripFn(init: Node): Node | null {
  let e = init;
  while (
    e &&
    (e.type === "TSAsExpression" ||
      e.type === "ParenthesizedExpression" ||
      e.type === "TSSatisfiesExpression")
  )
    e = e.expression;
  if (isFnNode(e)) return e;
  // wrapped forms: memo(fn), forwardRef(fn), useCallback(fn) etc.
  if (e?.type === "CallExpression") {
    for (const a of e.arguments ?? []) if (isFnNode(a)) return a;
  }
  return null;
}

function collect(path: string, src: string): Candidate[] {
  const r = parseSync(path, src, { lang: path.endsWith("x") ? "tsx" : "ts" });
  if (r.errors.length > 0 && r.errors.some((e) => e.severity === "Error")) return [];
  const out: Candidate[] = [];
  const program = r.program as Node;

  const push = (
    name: string,
    fn: Node,
    outer: Node,
    exported: boolean,
    topLevel: boolean,
    serverStyle: boolean,
  ) => {
    const body = fn.body;
    let stmts = 1;
    if (body?.type === "BlockStatement") {
      stmts = 0;
      visit(body, (n) => {
        if (/Statement$|Declaration$/.test(n.type) && n.type !== "BlockStatement") stmts++;
      });
    }
    let hasJsx = false;
    visit(body, (n) => {
      if (n.type === "JSXElement" || n.type === "JSXFragment") hasJsx = true;
    });
    const text = src.slice(outer.start, outer.end);
    out.push({
      path,
      name,
      exported,
      topLevel,
      isFn: true,
      fn,
      outer,
      stmts,
      loc: text.split("\n").length,
      hasJsx,
      serverStyle,
      src,
    });
  };

  const handleDecl = (decl: Node, outerForExport: Node | null, exported: boolean, topLevel: boolean) => {
    if (decl.type === "FunctionDeclaration" && decl.id) {
      push(decl.id.name, decl, outerForExport ?? decl, exported, topLevel, false);
    } else if (decl.type === "VariableDeclaration") {
      for (const d of decl.declarations) {
        if (d.id?.type !== "Identifier" || !d.init) continue;
        const fn = stripFn(d.init);
        if (fn) {
          const direct = isFnNode(d.init);
          push(
            d.id.name,
            fn,
            outerForExport ?? decl,
            exported,
            topLevel,
            !direct &&
              d.init.type === "CallExpression" &&
              !/^(memo|forwardRef|useCallback)$/.test(d.init.callee?.name ?? ""),
          );
        }
      }
    }
  };

  for (const stmt of program.body) {
    if (stmt.type === "ExportNamedDeclaration" && stmt.declaration)
      handleDecl(stmt.declaration, stmt, true, true);
    else if (
      stmt.type === "ExportDefaultDeclaration" &&
      stmt.declaration?.type === "FunctionDeclaration" &&
      stmt.declaration.id
    )
      push(stmt.declaration.id.name, stmt.declaration, stmt, true, true, false);
    else handleDecl(stmt, null, false, true);
  }

  // local helpers nested inside functions are out of scope; top-level only.
  return out;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function classify(c: Candidate): Stratum | null {
  const server = SERVER_DIRS.some((d) => c.path.startsWith(d));
  if (/^use[A-Z]/.test(c.name)) return c.exported || c.topLevel ? "hook" : null;
  if (/^[A-Z]/.test(c.name) && c.path.endsWith("x") && c.hasJsx) return "component";
  if (/^[A-Z]/.test(c.name)) return null; // PascalCase non-component: ambiguous, skip
  if (server && (c.exported || c.serverStyle)) return "server";
  if (c.exported) return server ? null : "util";
  return "helper";
}

/** Trivial = a single statement (e.g. a lone `return`). Hooks are the scarce stratum (~30 in the
 * test bed), so they only drop single-statement functions that are also short. */
function trivial(c: Candidate, stratum: Stratum): boolean {
  return stratum === "hook" ? c.stmts < 2 && c.loc < 8 : c.stmts < 2;
}

function leadingDoc(src: string, start: number): string | null {
  const before = src.slice(0, start).trimEnd();
  if (!before.endsWith("*/")) return null;
  const open = before.lastIndexOf("/**");
  if (open < 0) return null;
  const doc = before.slice(open);
  if (doc.includes("*/") && doc.indexOf("*/") !== doc.length - 2) return null;
  return doc
    .replace(/^\/\*\*|\*\/$/g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 400);
}

function buildFactSheet(c: Candidate, kind: "function" | "component" | "hook") {
  const text = c.src.slice(c.outer.start, c.outer.end);
  const bodyStart = c.fn.body ? c.fn.body.start - c.outer.start : text.length;
  const signature = text
    .slice(0, bodyStart)
    .replace(/\s*=>\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  const callees = new Set<string>();
  visit(c.fn.body, (n) => {
    if (n.type !== "CallExpression" && n.type !== "NewExpression") return;
    const cal = n.callee;
    if (cal?.type === "Identifier") callees.add(cal.name);
    else if (cal?.type === "MemberExpression" && !cal.computed && cal.property?.name)
      callees.add(cal.property.name);
  });
  const rt = c.fn.returnType?.typeAnnotation;
  const returnType = rt ? c.src.slice(rt.start, rt.end).replace(/\s+/g, " ").trim() : null;
  const exactHash = createHash("sha1").update(text.replace(/\s+/g, " ")).digest("hex").slice(0, 16);
  return {
    contentKey: `${exactHash}:${PROMPT_MAJOR}`,
    id: `sym:${c.path}#${c.name}`,
    path: c.path,
    kind,
    signature,
    doc: leadingDoc(c.src, c.outer.start),
    callees: [...callees].sort(),
    returnType,
    body: text.slice(0, BODY_LIMIT),
  };
}

function main(): void {
  const rootArg = process.argv[2] ?? process.env.DEVPRENTICE_PATH;
  if (!rootArg || SERVER_DIRS.length === 0) {
    process.stderr.write(
      "usage: DEVPRENTICE_PATH=<repo> LABELLED_SERVER_DIRS=<dir/,dir/> tsx evals/labelled/sample.ts\n",
    );
    process.exit(2);
  }
  const root = resolve(rootArg);
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(process.env.LABELLED_OUT ?? join(here, "..", "private", "labelled"));
  mkdirSync(outDir, { recursive: true });

  const files: string[] = [];
  for (const top of ["apps", "packages"]) walk(root, join(root, top), files);
  files.sort();

  const pools: Record<Stratum, Candidate[]> = { component: [], hook: [], util: [], server: [], helper: [] };
  for (const f of files) {
    const src = readFileSync(join(root, f), "utf8");
    for (const c of collect(f, src)) {
      const s = classify(c);
      if (s && !trivial(c, s)) pools[s].push(c);
    }
  }

  const rand = mulberry32(SEED);
  const rows: string[] = [];
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  for (const stratum of Object.keys(STRATA) as Stratum[]) {
    const pool = pools[stratum];
    // Fisher-Yates with the seeded PRNG over a deterministically ordered pool
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j] as Candidate, pool[i] as Candidate];
    }
    const perFile = new Map<string, number>();
    let n = 0;
    for (const c of pool) {
      if (n >= STRATA[stratum]) break;
      const id = `sym:${c.path}#${c.name}`;
      if (seen.has(id) || (perFile.get(c.path) ?? 0) >= MAX_PER_FILE) continue;
      seen.add(id);
      perFile.set(c.path, (perFile.get(c.path) ?? 0) + 1);
      const kind = stratum === "component" ? "component" : stratum === "hook" ? "hook" : "function";
      rows.push(JSON.stringify({ id, factSheet: buildFactSheet(c, kind), stratum }));
      n++;
    }
    counts[stratum] = n;
    console.error(`${stratum}: pool ${pool.length}, sampled ${n}/${STRATA[stratum]}`);
  }
  writeFileSync(join(outDir, "candidates.jsonl"), `${rows.join("\n")}\n`);
  writeFileSync(join(outDir, "sample-meta.json"), `${JSON.stringify({ seed: SEED, counts }, null, 2)}\n`);
  console.error(`wrote ${rows.length} candidates (seed ${SEED})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

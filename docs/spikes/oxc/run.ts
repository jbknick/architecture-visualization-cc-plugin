// Spike: oxc-parser + oxc-resolver import-binding graph over a target repo (read-only).
// Usage: pnpm tsx docs/spikes/oxc/run.ts <repo-root> [--runs N] [--private-out <file>]
// stdout carries only aggregate numbers and redacted shapes, so it is safe to paste into a public report.
// Full detail (real specifiers, paths) goes to --private-out, which must be under git-ignored evals/private/.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  analyzeFile,
  classifyResolved,
  type FileFacts,
  generaliseDir,
  isInternalSpecifier,
  listSourceFiles,
  median,
  oxcVersions,
  type ResolutionClass,
  ResolverFactory,
  redactSpecifier,
  routeFileShape,
  unresolvedReason,
} from "./analyze.js";

interface Summary {
  files: number;
  functions: number;
  parseErrors: number;
  imports: number;
  importsByKind: Record<string, number>;
  resolution: Record<ResolutionClass, number>;
  internalTotal: number;
  internalResolved: number;
  calls: Record<string, number>;
  callsByImportTarget: Record<ResolutionClass, number>;
  unresolved: { redacted: string; reason: string; count: number; examples: string[] }[];
  ecosystem: Ecosystem;
  timings: { parseMs: number; resolveMs: number; totalMs: number };
}

interface Ecosystem {
  fileRoutes: {
    files: number;
    calls: number;
    rootRoutes: number;
    dirs: Record<string, number>;
    shapes: Record<string, number>;
    optionKeys: Record<string, number>;
    withParams: number;
    pathless: number;
  };
  hono: { files: number; dirs: Record<string, number> };
  orpc: { files: number; implementFiles: number; dirs: Record<string, number> };
  drizzle: { files: number; tables: number; dirs: Record<string, number> };
  serverFns: { files: number; calls: number; dirs: Record<string, number> };
}

const bump = (m: Record<string, number>, k: string, by = 1) => {
  m[k] = (m[k] ?? 0) + by;
};

function workspaceNames(root: string): Set<string> {
  const out = execFileSync("git", ["-C", root, "ls-files", "package.json", "**/package.json"], {
    encoding: "utf8",
  });
  const names = new Set<string>();
  for (const rel of out.split("\n").filter(Boolean)) {
    if (rel.includes("node_modules/")) continue;
    try {
      const pkg = JSON.parse(readFileSync(join(root, rel), "utf8")) as { name?: string };
      if (pkg.name) names.add(pkg.name);
    } catch {
      // unreadable package.json: skip
    }
  }
  return names;
}

interface PrivateDetail {
  unresolved: Record<string, { reason: string; count: number; error?: string; from: string[] }>;
  routeFiles: string[];
  honoFiles: string[];
  orpcFiles: string[];
  drizzleFiles: string[];
  serverFnFiles: string[];
}

export function runOnce(
  root: string,
  files: string[],
  names: Set<string>,
): { summary: Summary; detail: PrivateDetail } {
  const ctx = { workspaceNames: names };
  const t0 = performance.now();
  let parseMs = 0;
  let resolveMs = 0;

  const resolver = new ResolverFactory({
    conditionNames: ["import", "types", "default"],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js"],
    tsconfig: "auto",
    builtinModules: true,
  });

  const s: Summary = {
    files: files.length,
    functions: 0,
    parseErrors: 0,
    imports: 0,
    importsByKind: {},
    resolution: { repo: 0, node_modules: 0, builtin: 0, unresolved: 0 },
    internalTotal: 0,
    internalResolved: 0,
    calls: { import: 0, "top-level": 0, "local-scope": 0, global: 0 },
    callsByImportTarget: { repo: 0, node_modules: 0, builtin: 0, unresolved: 0 },
    unresolved: [],
    ecosystem: {
      fileRoutes: {
        files: 0,
        calls: 0,
        rootRoutes: 0,
        dirs: {},
        shapes: {},
        optionKeys: {},
        withParams: 0,
        pathless: 0,
      },
      hono: { files: 0, dirs: {} },
      orpc: { files: 0, implementFiles: 0, dirs: {} },
      drizzle: { files: 0, tables: 0, dirs: {} },
      serverFns: { files: 0, calls: 0, dirs: {} },
    },
    timings: { parseMs: 0, resolveMs: 0, totalMs: 0 },
  };
  const detail: PrivateDetail = {
    unresolved: {},
    routeFiles: [],
    honoFiles: [],
    orpcFiles: [],
    drizzleFiles: [],
    serverFnFiles: [],
  };
  const groups = new Map<
    string,
    { redacted: string; reason: string; count: number; examples: Set<string> }
  >();

  for (const rel of files) {
    const abs = join(root, rel);
    const source = readFileSync(abs, "utf8");
    const p0 = performance.now();
    const facts: FileFacts = analyzeFile(abs, source);
    parseMs += performance.now() - p0;

    s.parseErrors += facts.parseErrors ? 1 : 0;
    s.functions += facts.functions.length;

    const importClass: ResolutionClass[] = [];
    const r0 = performance.now();
    for (const imp of facts.imports) {
      if (!imp.specifier) {
        importClass.push("unresolved");
        continue;
      }
      const r = resolver.resolveFileSync(abs, imp.specifier);
      const cls = classifyResolved(root, r);
      importClass.push(cls);
      s.imports++;
      bump(s.importsByKind, imp.kind);
      s.resolution[cls]++;
      const internal = cls === "repo" || (cls === "unresolved" && isInternalSpecifier(imp.specifier, ctx));
      if (internal) {
        s.internalTotal++;
        if (cls === "repo") s.internalResolved++;
      }
      if (cls === "unresolved") {
        const reason = unresolvedReason(imp.specifier, r.error, ctx);
        const redacted = redactSpecifier(imp.specifier, ctx);
        const key = `${redacted}\u0000${reason}`;
        const g = groups.get(key) ?? { redacted, reason, count: 0, examples: new Set<string>() };
        g.count++;
        groups.set(key, g);
        const d = detail.unresolved[imp.specifier] ?? {
          reason,
          count: 0,
          error: r.error,
          from: [] as string[],
        };
        d.count++;
        if (d.from.length < 5) d.from.push(rel);
        detail.unresolved[imp.specifier] = d;
      }
    }
    resolveMs += performance.now() - r0;

    for (const c of facts.calls) {
      bump(s.calls, c.classification);
      if (c.classification === "import" && c.importIndex !== null) {
        s.callsByImportTarget[importClass[c.importIndex] ?? "unresolved"]++;
      }
    }

    // ecosystem shapes (generalised: no workspace or file names)
    const eco = s.ecosystem;
    const gdir = generaliseDir(rel);
    const specs = facts.imports.map((i) => i.specifier);
    const m = facts.markers;
    if (m.createFileRoute) {
      eco.fileRoutes.files++;
      eco.fileRoutes.calls += m.createFileRoute;
      bump(eco.fileRoutes.dirs, gdir);
      bump(eco.fileRoutes.shapes, routeFileShape(rel));
      detail.routeFiles.push(rel);
      for (const [k, v] of Object.entries(facts.routeKeys)) bump(eco.fileRoutes.optionKeys, k, v);
      for (const rp of facts.routePaths) {
        if (rp.includes("$")) eco.fileRoutes.withParams++;
        if (/\/_[^/]/.test(rp)) eco.fileRoutes.pathless++;
      }
    }
    if (m.createRootRoute || m.createRootRouteWithContext) eco.fileRoutes.rootRoutes++;
    if (m.Hono || m.OpenAPIHono || specs.includes("hono")) {
      eco.hono.files++;
      bump(eco.hono.dirs, gdir);
      detail.honoFiles.push(rel);
    }
    if (specs.some((x) => x === "@orpc/server" || x.startsWith("@orpc/server/"))) {
      eco.orpc.files++;
      if (m.implement) eco.orpc.implementFiles++;
      bump(eco.orpc.dirs, gdir);
      detail.orpcFiles.push(rel);
    }
    if (m.sqliteTable) {
      eco.drizzle.files++;
      eco.drizzle.tables += m.sqliteTable;
      bump(eco.drizzle.dirs, gdir);
      detail.drizzleFiles.push(rel);
    }
    if (m.createServerFn) {
      eco.serverFns.files++;
      eco.serverFns.calls += m.createServerFn;
      bump(eco.serverFns.dirs, gdir);
      detail.serverFnFiles.push(rel);
    }
  }

  s.unresolved = [...groups.values()]
    .sort((a, b) => b.count - a.count || a.redacted.localeCompare(b.redacted))
    .map((g) => ({ redacted: g.redacted, reason: g.reason, count: g.count, examples: [...g.examples] }));
  s.timings = { parseMs, resolveMs, totalMs: performance.now() - t0 };
  return { summary: s, detail };
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
const ms = (n: number) => n.toFixed(0);

function top(m: Record<string, number>, n = 12): string {
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([k, v]) => `    ${String(v).padStart(5)}  ${k}`)
    .join("\n");
}

export function render(s: Summary, medians: Summary["timings"], runs: number): string {
  const totalCalls = Object.values(s.calls).reduce((a, b) => a + b, 0);
  const mapped = (s.calls.import ?? 0) + (s.calls["top-level"] ?? 0);
  const resolvedImportCalls = (s.calls.import ?? 0) - s.callsByImportTarget.unresolved;
  const lines: string[] = [];
  const row = (k: string, v: string | number) => lines.push(`${k.padEnd(46)}${v}`);
  lines.push(`oxc-parser ${oxcVersions.parser}, oxc-resolver ${oxcVersions.resolver}`);
  lines.push("");
  row("files parsed", s.files);
  row("files with parse errors", s.parseErrors);
  row("top-level functions (fn + const-arrow)", s.functions);
  row("imports (static + re-export + dynamic)", s.imports);
  row("  by kind", JSON.stringify(s.importsByKind));
  row("  resolved to repo file", s.resolution.repo);
  row("  resolved to node_modules", s.resolution.node_modules);
  row("  node builtin", s.resolution.builtin);
  row("  unresolved", s.resolution.unresolved);
  row("% of all imports resolved", pct(s.imports - s.resolution.unresolved, s.imports));
  row("repo-internal imports (resolved + unresolved)", s.internalTotal);
  row("% of repo-internal imports resolved", pct(s.internalResolved, s.internalTotal));
  row("call sites inside function bodies", totalCalls);
  row("  mapped to imported binding", s.calls.import ?? 0);
  row("    binding resolves to repo file", s.callsByImportTarget.repo);
  row("    binding resolves to node_modules", s.callsByImportTarget.node_modules);
  row("    binding resolves to builtin", s.callsByImportTarget.builtin);
  row("    binding unresolved", s.callsByImportTarget.unresolved);
  row("  mapped to top-level declaration", s.calls["top-level"] ?? 0);
  row("  callee declared in local scope", s.calls["local-scope"] ?? 0);
  row("  unmapped (global or unknown)", s.calls.global ?? 0);
  row("% of call sites mapped to a binding", pct(mapped, totalCalls));
  row(
    "% mapped to a binding whose import resolved",
    pct(resolvedImportCalls + (s.calls["top-level"] ?? 0), totalCalls),
  );
  lines.push("");
  lines.push(`timings (median of ${runs} runs, ms)`);
  row("  parse (read excluded)", ms(medians.parseMs));
  row("  resolve", ms(medians.resolveMs));
  row("  end-to-end (read + parse + resolve + walk)", ms(medians.totalMs));
  lines.push("");
  lines.push(`top 20 unresolved specifiers (grouped, redacted; ${s.unresolved.length} distinct groups)`);
  for (const g of s.unresolved.slice(0, 20)) {
    lines.push(`  ${String(g.count).padStart(5)}  ${g.redacted}  --  ${g.reason}`);
  }
  const e = s.ecosystem;
  lines.push("");
  lines.push("framework shapes (generalised paths, counts only)");
  lines.push(
    `  createFileRoute: ${e.fileRoutes.calls} calls in ${e.fileRoutes.files} files; root routes: ${e.fileRoutes.rootRoutes}; paths with $param: ${e.fileRoutes.withParams}; pathless (_) paths: ${e.fileRoutes.pathless}`,
  );
  lines.push("  route dirs:");
  lines.push(top(e.fileRoutes.dirs));
  lines.push("  route file naming:");
  lines.push(top(e.fileRoutes.shapes));
  lines.push("  route option keys:");
  lines.push(top(e.fileRoutes.optionKeys));
  lines.push(`  hono: ${e.hono.files} files`);
  lines.push(top(e.hono.dirs));
  lines.push(
    `  oRPC server (@orpc/server importers): ${e.orpc.files} files, ${e.orpc.implementFiles} call implement()`,
  );
  lines.push(top(e.orpc.dirs));
  lines.push(`  drizzle sqliteTable: ${e.drizzle.tables} tables in ${e.drizzle.files} files`);
  lines.push(top(e.drizzle.dirs));
  lines.push(`  createServerFn: ${e.serverFns.calls} calls in ${e.serverFns.files} files`);
  lines.push(top(e.serverFns.dirs));
  return lines.join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const rootArg = args.find(
    (a) =>
      !a.startsWith("--") &&
      args[args.indexOf(a) - 1] !== "--runs" &&
      args[args.indexOf(a) - 1] !== "--private-out",
  );
  if (!rootArg) {
    console.error("usage: run.ts <repo-root> [--runs N] [--private-out <file>]");
    process.exit(2);
  }
  const runsIdx = args.indexOf("--runs");
  const runs = runsIdx >= 0 ? Number(args[runsIdx + 1]) : 3;
  const outIdx = args.indexOf("--private-out");
  const privateOut = outIdx >= 0 ? resolve(args[outIdx + 1] as string) : null;
  const root = realpathSync(resolve(rootArg)); // the resolver returns realpaths

  const names = workspaceNames(root);
  const all: Summary[] = [];
  let lastDetail: PrivateDetail | null = null;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const files = listSourceFiles(root);
    const listMs = performance.now() - t0;
    const { summary, detail } = runOnce(root, files, names);
    summary.timings.totalMs += listMs; // include file discovery in end-to-end
    all.push(summary);
    lastDetail = detail;
  }
  const medians = {
    parseMs: median(all.map((a) => a.timings.parseMs)),
    resolveMs: median(all.map((a) => a.timings.resolveMs)),
    totalMs: median(all.map((a) => a.timings.totalMs)),
  };
  const last = all[all.length - 1] as Summary;
  console.log(render(last, medians, runs));
  console.log(`\nraw run totals (ms): ${all.map((a) => ms(a.timings.totalMs)).join(", ")}`);

  if (privateOut && lastDetail) {
    mkdirSync(dirname(privateOut), { recursive: true });
    writeFileSync(privateOut, `${JSON.stringify({ summary: last, detail: lastDetail }, null, 2)}\n`);
    console.error(`private detail written to ${privateOut}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) main();

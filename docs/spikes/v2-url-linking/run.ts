// Spike: link client calls to handlers by method and path when base URLs come from env vars.
// Usage: pnpm tsx docs/spikes/v2-url-linking/run.ts [--sosrs <frontend-dir> <backend-dir>] [--juga <repo-dir>] [--verbose]
// 1. Today: the real indexer (packages/core indexRepo, clients adapter) on a temp git repo per case.
// 2. Prototype: proto.ts with M11 normalisation and a base-URL -> repo config, against the same endpoints.
// Both are scored against hand labels (labels.ts).
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dumpGraph, indexRepo } from "../../../packages/core/src/indexer.js";
import { resolvePaths } from "../../../packages/core/src/paths/index.js";
import { openStore } from "../../../packages/core/src/store/index.js";
import { FIXTURE_LABELS, JUGA_LABELS, type Label, SOSRS_LABELS } from "./labels.js";
import { type CallResult, type Endpoint, type LinkConfig, linkCalls } from "./proto.js";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const sIdx = args.indexOf("--sosrs");
const sosrs =
  sIdx >= 0 ? { fe: resolve(args[sIdx + 1] as string), be: resolve(args[sIdx + 2] as string) } : null;
const jIdx = args.indexOf("--juga");
const juga = jIdx >= 0 ? resolve(args[jIdx + 1] as string) : null;
const temps: string[] = [];

function gitRepo(dir: string): void {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "x",
  );
}

interface Graph {
  nodes: { id: string; kind: string; ws?: string; data: Record<string, unknown> }[];
  edges: { src: string; dst: string; kind: string; confidence: string; evidence: string[] }[];
}
async function indexDir(dir: string): Promise<{ graph: Graph; ms: number }> {
  const data = mkdtempSync(join(tmpdir(), "v2-url-data-"));
  temps.push(data);
  const paths = resolvePaths(dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  const t0 = performance.now();
  await indexRepo(paths, { layer: "main" });
  const ms = performance.now() - t0;
  const store = openStore(paths.dbPath);
  try {
    const g = dumpGraph(store);
    return {
      graph: { nodes: (g.adapterNodes ?? []) as Graph["nodes"], edges: g.edges as Graph["edges"] },
      ms,
    };
  } finally {
    store.close();
  }
}

const wsOf = (n: { ws?: string }) => (n.ws ?? "").replace(/^ws:/, "");
function endpointsOf(g: Graph): Map<string, Endpoint & { label: string }> {
  const out = new Map<string, Endpoint & { label: string }>();
  for (const n of g.nodes) {
    if (n.kind !== "endpoint" || n.data.adapter !== "hono") continue;
    const ep = { method: n.data.method as string, path: n.data.path as string, repo: wsOf(n) };
    out.set(n.id, { ...ep, label: `${ep.method} ${ep.path} @${ep.repo}` });
  }
  return out;
}

/** Today's per-call predictions: `requests` edges by evidence line, plus `client_call` gap nodes. */
function todayPredictions(g: Graph): Map<string, { dsts: string[]; reason?: string }> {
  const eps = endpointsOf(g);
  const out = new Map<string, { dsts: string[]; reason?: string }>();
  for (const e of g.edges) {
    if (e.kind !== "requests") continue;
    const ep = eps.get(e.dst);
    if (!ep) continue;
    for (const ev of e.evidence) {
      const cur = out.get(ev) ?? { dsts: [] };
      cur.dsts.push(ep.label);
      out.set(ev, cur);
    }
  }
  for (const n of g.nodes) {
    if (n.kind !== "client_call") continue;
    const lines = (n.data.lines as number[] | undefined) ?? [n.data.line as number];
    for (const l of lines) {
      const k = `${n.data.file as string}:${l}`;
      if (!out.has(k))
        out.set(k, { dsts: [], reason: `${n.data.reason as string} (${n.data.label as string})` });
    }
  }
  return out;
}

interface Score {
  labelled: number;
  linkable: number;
  predictedLinks: number;
  correct: number;
  wrong: number;
  falseOnNull: number;
  missed: number;
  unlabelled: string[];
  rows: { label: Label; got: string }[];
}
function score(labels: Label[], pred: Map<string, { dsts: string[]; reason?: string }>): Score {
  const s: Score = {
    labelled: labels.length,
    linkable: 0,
    predictedLinks: 0,
    correct: 0,
    wrong: 0,
    falseOnNull: 0,
    missed: 0,
    unlabelled: [],
    rows: [],
  };
  const keys = new Set(labels.map((l) => `${l.file}:${l.line}`));
  for (const l of labels) {
    const p = pred.get(`${l.file}:${l.line}`);
    // A link is exactly one endpoint; several candidates are a listed ambiguity, not a link.
    const link = p && p.dsts.length === 1 ? (p.dsts[0] as string) : null;
    if (l.expect) s.linkable++;
    if (link) s.predictedLinks++;
    if (l.expect && link === l.expect) s.correct++;
    else if (l.expect && link) s.wrong++;
    else if (l.expect) s.missed++;
    else if (link) s.falseOnNull++;
    const got =
      link ?? (p ? (p.dsts.length > 1 ? `ambiguous: ${p.dsts.join(", ")}` : (p.reason ?? "-")) : "not seen");
    s.rows.push({ label: l, got });
  }
  for (const [k, p] of pred)
    if (!keys.has(k) && p.dsts.length > 0) s.unlabelled.push(`${k} -> ${p.dsts.join(", ")}`);
  return s;
}

function protoPredictions(results: CallResult[]): Map<string, { dsts: string[]; reason?: string }> {
  const out = new Map<string, { dsts: string[]; reason?: string }>();
  for (const r of results) {
    const reason = r.reason ? `${r.reason} (${r.method} ${r.url})` : undefined;
    out.set(`${r.file}:${r.line}`, { dsts: r.dsts, ...(reason ? { reason } : {}) });
  }
  return out;
}

function printScore(name: string, s: Score): void {
  const p = s.predictedLinks === 0 ? 0 : s.correct / s.predictedLinks;
  const r = s.linkable === 0 ? 0 : s.correct / s.linkable;
  console.log(
    `| ${name} | ${s.labelled} | ${s.linkable} | ${s.correct} | ${s.wrong} | ${s.falseOnNull} | ${s.missed} | ${(p * 100).toFixed(0)}% | ${(r * 100).toFixed(0)}% |`,
  );
  if (s.unlabelled.length > 0) console.log(`  unlabelled links: ${s.unlabelled.join("; ")}`);
}
const HEADER =
  "| Run | Call sites | Linkable | Correct | Wrong endpoint | Link where none | Missed | Precision | Recall |\n|---|---|---|---|---|---|---|---|---|";

function printRows(title: string, today: Score, proto: Score): void {
  console.log(`\n### ${title}: per call site\n`);
  console.log("| Site | Pattern | Expected | Today | Prototype |\n|---|---|---|---|---|");
  today.rows.forEach((t, i) => {
    const p = proto.rows[i] as Score["rows"][number];
    const site = `${t.label.file.replace(/^apps\/web\/src\//, "")}:${t.label.line}`;
    const mark = (got: string) =>
      got === (t.label.expect ?? "") || (!t.label.expect && !got.includes(" @")) ? "ok" : "x";
    console.log(
      `| ${site} | ${t.label.pattern} | ${t.label.expect ?? "none"} | ${mark(t.got)} ${t.got} | ${mark(p.got)} ${p.got} |`,
    );
  });
}

function listTs(dir: string): { abs: string; rel: string }[] {
  const out = execFileSync("git", ["ls-files", "*.ts", "*.tsx"], { cwd: dir, encoding: "utf8" });
  const root = realpathSync(dir);
  return out
    .split("\n")
    .filter((f) => f && !f.endsWith(".d.ts"))
    .map((rel) => ({ abs: join(root, rel), rel }));
}

// --- NestJS endpoints -> a Hono shim, so today's indexer has endpoints to match against ---------
/** `@Controller('x')` and `@Get(':id')` decorators, read by regex (the backend here is plain enough). */
function nestEndpoints(beDir: string): { method: string; path: string; file: string }[] {
  const out: { method: string; path: string; file: string }[] = [];
  for (const { abs, rel } of listTs(beDir)) {
    if (!rel.endsWith(".controller.ts")) continue;
    const src = readFileSync(abs, "utf8");
    const ctrl = /@Controller\(\s*['"`]([^'"`]*)['"`]\s*\)/.exec(src)?.[1] ?? "";
    for (const m of src.matchAll(/@(Get|Post|Put|Patch|Delete|All)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g)) {
      const path = `/${[ctrl, m[2] ?? ""].filter(Boolean).join("/")}`
        .replace(/\/+/g, "/")
        .replace(/(.)\/$/, "$1");
      out.push({ method: (m[1] as string).toUpperCase(), path, file: rel });
    }
  }
  return out.sort((a, b) => (a.path + a.method < b.path + b.method ? -1 : 1));
}

async function main(): Promise<void> {
  // Case A: the fixture (three workspaces stand in for three repos: web, users-api, billing).
  const a = mkdtempSync(join(tmpdir(), "v2-url-fixture-"));
  temps.push(a);
  cpSync(join(here, "fixtures/multi"), a, { recursive: true });
  gitRepo(a);
  const ga = await indexDir(a);
  const epsA = [...endpointsOf(ga.graph).values()];
  console.log(
    `## Case A: fixture (${epsA.length} Hono endpoints found by today's indexer, ${ga.ms.toFixed(0)} ms)\n`,
  );
  const cfgA: LinkConfig = {
    inferWrappers: true,
    conditionals: true,
    bases: {
      "env:VITE_API_URL": { repo: "@fx/users-api", prefix: "/api" },
      "env:API_URL": { repo: "@fx/users-api", prefix: "/api" },
      "env:VITE_BILLING_URL": { repo: "@fx/billing" },
      "env:BILLING_URL": { repo: "@fx/billing" },
      "url:http://localhost:4000": { repo: "@fx/billing" },
      "path:/api": { repo: "@fx/users-api" },
    },
  };
  const webA = listTs(a).filter((f) => f.rel.startsWith("apps/web/"));
  const todayA = score(FIXTURE_LABELS, todayPredictions(ga.graph));
  const protoA = score(FIXTURE_LABELS, protoPredictions(linkCalls(webA, epsA, cfgA)));
  const protoA0 = score(FIXTURE_LABELS, protoPredictions(linkCalls(webA, epsA, { ...cfgA, bases: {} })));
  const protoA1 = score(
    FIXTURE_LABELS,
    protoPredictions(linkCalls(webA, epsA, { ...cfgA, inferWrappers: false })),
  );
  console.log(HEADER);
  printScore("Today (clients.ts, real indexer)", todayA);
  printScore("Prototype, no base config", protoA0);
  printScore("Prototype, base config, no wrapper inference", protoA1);
  printScore("Prototype, base config + wrapper inference", protoA);
  printRows("Case A", todayA, protoA);

  if (sosrs) {
    await pairCase(
      "B: public frontend + NestJS backend, separate repos",
      sosrs.fe,
      sosrs.be,
      "sosrs-api",
      SOSRS_LABELS,
      {
        "env:VITE_API_URL": { repo: "sosrs-api" },
        "url:http://localhost:4000": { repo: "sosrs-api" },
      },
    );
  }
  if (juga) {
    // Held out: labelled and run after the prototype was written. VITE_API_URL's value is not in the repo; its
    // `/api` prefix is read from the Vite dev proxy (`/api` -> server) and the controllers' `/api/...` paths.
    await pairCase(
      "C: public monorepo, Vite frontend + NestJS backend (held out)",
      join(juga, "FE"),
      join(juga, "BE"),
      "juga-api",
      JUGA_LABELS,
      {
        "env:VITE_API_URL": { repo: "juga-api", prefix: "/api" },
        "path:/api": { repo: "juga-api" },
      },
    );
  }
}

/** A frontend and a NestJS backend, combined as two workspaces (the backend as a Hono shim of its controllers). */
async function pairCase(
  title: string,
  fe: string,
  be: string,
  apiName: string,
  labels: Label[],
  bases: LinkConfig["bases"],
): Promise<void> {
  const b = mkdtempSync(join(tmpdir(), "v2-url-pair-"));
  temps.push(b);
  writeFileSync(join(b, "package.json"), '{ "name": "pair-combined", "private": true }\n');
  writeFileSync(join(b, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');
  mkdirSync(join(b, "apps/web"), { recursive: true });
  for (const f of execFileSync("git", ["ls-files"], { cwd: fe, encoding: "utf8" }).split("\n")) {
    if (!f) continue;
    mkdirSync(dirname(join(b, "apps/web", f)), { recursive: true });
    cpSync(join(fe, f), join(b, "apps/web", f));
  }
  const nest = nestEndpoints(be);
  mkdirSync(join(b, "apps/api/src"), { recursive: true });
  writeFileSync(
    join(b, "apps/api/package.json"),
    `{ "name": "${apiName}", "private": true, "type": "module", "dependencies": { "hono": "^4.0.0" } }\n`,
  );
  const lines = nest.map(
    (e) => `app.${e.method.toLowerCase()}(${JSON.stringify(e.path)}, (c) => c.json({}));`,
  );
  writeFileSync(
    join(b, "apps/api/src/app.ts"),
    `import { Hono } from "hono";\n\nexport const app = new Hono();\n${lines.join("\n")}\n`,
  );
  gitRepo(b);
  const gb = await indexDir(b);
  const eps = [...endpointsOf(gb.graph).values()];
  const web = listTs(b).filter((f) => f.rel.startsWith("apps/web/"));
  console.log(
    `\n## Case ${title} (${nest.length} controller endpoints, ${eps.length} in the Hono shim, ${web.length} frontend TS files, index ${gb.ms.toFixed(0)} ms)\n`,
  );
  const cfg: LinkConfig = { inferWrappers: true, conditionals: true, bases };
  const today = score(labels, todayPredictions(gb.graph));
  const t0 = performance.now();
  const res = linkCalls(web, eps, cfg);
  const protoMs = performance.now() - t0;
  const proto = score(labels, protoPredictions(res));
  console.log(HEADER);
  printScore("Today (clients.ts, real indexer)", today);
  printScore(
    "Prototype, no base config",
    score(labels, protoPredictions(linkCalls(web, eps, { ...cfg, bases: {} }))),
  );
  printScore(
    "Prototype, base config, no wrapper inference",
    score(labels, protoPredictions(linkCalls(web, eps, { ...cfg, inferWrappers: false }))),
  );
  printScore(
    "Prototype, base config, no conditional branches",
    score(labels, protoPredictions(linkCalls(web, eps, { ...cfg, conditionals: false }))),
  );
  printScore("Prototype, full", proto);
  console.log(`\nPrototype time over ${web.length} files: ${protoMs.toFixed(0)} ms`);
  printRows(`Case ${title.slice(0, 1)}`, today, proto);
  if (verbose) for (const r of res) console.log(JSON.stringify(r));
}

try {
  await main();
} finally {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
}

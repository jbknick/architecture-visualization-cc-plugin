// Spike: can exactHash / renamedHash / shapeHash / minhash / nearMinhash come from shared code fed by a
// language-supplied token stream, with TypeScript output byte-identical? And would a shared, language-blind
// normaliser (tree-sitter kinds) keep the same duplicate pairs?
// Usage: pnpm tsx docs/spikes/v2-token-hash/run.ts
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashSymbol } from "../../../packages/core/src/hash/index.js";
import { indexRepo } from "../../../packages/core/src/indexer.js";
import { parseSource } from "../../../packages/core/src/parse/index.js";
import { resolvePaths } from "../../../packages/core/src/paths/index.js";
import { openStore } from "../../../packages/core/src/store/index.js";
import { decodeMinhash } from "../../../packages/core/src/store/repo.js";
import { genericShape } from "./generic.js";
import { type Hashes, hashStreams, jaccard, minhash } from "./shared-hash.js";
import { loadTsNormaliser, tsStreams } from "./ts-normaliser.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const langOf = (p: string): "ts" | "tsx" => (p.endsWith(".tsx") ? "tsx" : "ts");
const FIELDS = ["exactHash", "renamedHash", "shapeHash", "minhash", "nearMinhash"] as const;

function listTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir).sort()) {
    if (e === "node_modules" || e === "dist" || e === "__snapshots__") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) listTs(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !e.endsWith(".d.ts") && !e.endsWith(".data.ts")) out.push(p);
  }
  return out;
}

const eq = (a: Hashes[keyof Hashes], b: Hashes[keyof Hashes]): boolean =>
  typeof a === "string"
    ? a === b
    : Buffer.from((a as Uint32Array).buffer).equals(Buffer.from((b as Uint32Array).buffer));

interface Sym {
  key: string;
  source: string;
  range: { start: number; end: number };
  lang: "ts" | "tsx";
  stmts: number;
}

function symbolsOf(files: string[], base: string): Sym[] {
  const out: Sym[] = [];
  for (const f of files) {
    const rel = relative(base, f).split("\\").join("/");
    const source = readFileSync(f, "utf8");
    const pf = parseSource("repo", rel, source);
    for (const s of pf.symbols) {
      const range = pf.bodies.get(s.id);
      if (range) out.push({ key: s.id, source, range, lang: langOf(rel), stmts: s.stmtCount ?? 0 });
    }
  }
  return out;
}

/** Part 1: split pipeline vs today's hashSymbol, field by field. */
function identity(label: string, syms: Sym[]): void {
  const same = Object.fromEntries(FIELDS.map((f) => [f, 0])) as Record<(typeof FIELDS)[number], number>;
  for (const s of syms) {
    const today = hashSymbol(s.source, s.range, s.lang);
    const split = hashStreams(tsStreams(s.source, s.range, s.lang));
    for (const f of FIELDS) if (eq(today[f], split[f])) same[f]++;
  }
  console.log(
    `${label}: ${syms.length} symbols; identical ${FIELDS.map((f) => `${f} ${same[f]}/${syms.length}`).join(", ")}`,
  );
}

/** Part 1b: what the real indexer stored for fixtures/pnpm-turbo vs the split pipeline. */
async function storeCheck(fixture: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "spike-token-fx-"));
  const data = mkdtempSync(join(tmpdir(), "spike-token-data-"));
  try {
    cpSync(fixture, dir, { recursive: true });
    const git = (args: string[]) =>
      execFileSync("git", ["-c", "user.name=f", "-c", "user.email=f@example.invalid", ...args], {
        cwd: dir,
        stdio: "ignore",
      });
    git(["init", "-b", "main"]);
    git(["add", "-A", "-f"]);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "fx"]);
    const paths = resolvePaths(dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
    await indexRepo(paths, { layer: "main" });
    const store = openStore(paths.dbPath);
    const rows = store.db
      .prepare(
        `SELECT s.id, s.exact_hash, s.renamed_hash, s.shape_hash, s.minhash, s.near_minhash, f.path
         FROM symbols s JOIN files f ON f.id = s.file_id AND f.layer = s.layer
         WHERE s.layer = 'main' ORDER BY s.id`,
      )
      .all() as {
      id: string;
      exact_hash: string;
      renamed_hash: string | null;
      shape_hash: string;
      minhash: Buffer;
      near_minhash: Buffer | null;
      path: string;
    }[];
    store.close();
    let ok = 0;
    const bad: string[] = [];
    const parsed = new Map<string, ReturnType<typeof parseSource> & { source: string }>();
    for (const r of rows) {
      let pf = parsed.get(r.path);
      if (!pf) {
        const source = readFileSync(join(dir, r.path), "utf8");
        pf = { ...parseSource("repo", r.path, source), source };
        parsed.set(r.path, pf);
      }
      const range = pf.bodies.get(r.id);
      if (!range) {
        bad.push(`${r.id} (no body)`);
        continue;
      }
      const h = hashStreams(tsStreams(pf.source, range, langOf(r.path)));
      const match =
        h.exactHash === r.exact_hash &&
        h.renamedHash === (r.renamed_hash ?? "") &&
        h.shapeHash === r.shape_hash &&
        eq(h.minhash, decodeMinhash(r.minhash)) &&
        eq(h.nearMinhash, decodeMinhash(r.near_minhash));
      if (match) ok++;
      else bad.push(r.id);
    }
    console.log(
      `store of ${relative(repo, fixture)}: ${ok}/${rows.length} symbols byte-identical to the split pipeline`,
    );
    if (bad.length > 0) console.log(`  mismatches: ${bad.slice(0, 10).join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
}

/** Part 2: a language-blind normaliser (tree-sitter kinds) vs today's oxc shape stream, by duplicate pairs. */
function generic(label: string, syms: Sym[], threshold: number): void {
  const big = syms.filter((s) => s.stmts >= 6);
  const oxcShape = big.map((s) => tsStreams(s.source, s.range, s.lang).shape);
  const tsShape = big.map((s) => genericShape(s.source, s.range, s.lang));
  const sameHash = big.filter((_, i) => oxcShape[i]?.join("\n") === tsShape[i]?.join("\n")).length;
  const mo = oxcShape.map(minhash);
  const mg = tsShape.map(minhash);
  let oxcPairs = 0;
  let genPairs = 0;
  let both = 0;
  let shapeO = 0;
  let shapeG = 0;
  let shapeBoth = 0;
  const so = oxcShape.map((s) => s.join("\n"));
  const sg = tsShape.map((s) => s.join("\n"));
  for (let i = 0; i < big.length; i++) {
    for (let j = i + 1; j < big.length; j++) {
      const a = jaccard(mo[i] as Uint32Array, mo[j] as Uint32Array) >= threshold;
      const b = jaccard(mg[i] as Uint32Array, mg[j] as Uint32Array) >= threshold;
      if (a) oxcPairs++;
      if (b) genPairs++;
      if (a && b) both++;
      const x = so[i] === so[j];
      const y = sg[i] === sg[j];
      if (x) shapeO++;
      if (y) shapeG++;
      if (x && y) shapeBoth++;
    }
  }
  const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
  console.log(
    `${label}: ${big.length} symbols with >= 6 statements; generic stream equals oxc stream for ${sameHash}`,
  );
  console.log(
    `  shape-MinHash pairs >= ${threshold}: oxc ${oxcPairs}, generic ${genPairs}, both ${both} ` +
      `(generic recall ${pct(both, oxcPairs)}, precision ${pct(both, genPairs)})`,
  );
  console.log(
    `  equal-shapeHash pairs: oxc ${shapeO}, generic ${shapeG}, both ${shapeBoth} ` +
      `(recall ${pct(shapeBoth, shapeO)}, precision ${pct(shapeBoth, shapeG)})`,
  );
}

await loadTsNormaliser();
console.log("## Part 1: shared hashing fed by the TypeScript token stream");
for (const fx of ["pnpm-turbo", "adapters", "single-pkg", "nx"]) {
  const base = join(repo, "fixtures", fx);
  identity(`fixtures/${fx}`, symbolsOf(listTs(base), base));
}
const ownFiles = ["core", "cli", "mcp", "explorer"].flatMap((p) => listTs(join(repo, "packages", p)));
const own = symbolsOf(ownFiles, repo);
identity("packages/* (this repo)", own);
await storeCheck(join(repo, "fixtures/pnpm-turbo"));

console.log("\n## Part 2: shared, language-blind normaliser (tree-sitter kinds) for TypeScript");
const turbo = join(repo, "fixtures/pnpm-turbo");
const turboSyms = symbolsOf(listTs(turbo), turbo);
const t0 = turboSyms.find((s) => s.key.includes("formatRelativeDate"));
const t1 = turboSyms.find((s) => s.key.includes("parseTimestamp"));
if (t0 && t1) {
  const o = jaccard(
    minhash(tsStreams(t0.source, t0.range, t0.lang).shape),
    minhash(tsStreams(t1.source, t1.range, t1.lang).shape),
  );
  const g = jaccard(
    minhash(genericShape(t0.source, t0.range, t0.lang)),
    minhash(genericShape(t1.source, t1.range, t1.lang)),
  );
  console.log(
    `fixture near-duplicate formatRelativeDate ~ parseTimestamp: shape Jaccard oxc ${o.toFixed(3)}, generic ${g.toFixed(3)}`,
  );
}
generic("packages/* (this repo)", own, 0.85);

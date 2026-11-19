import fs from "node:fs";
import path from "node:path";
import {
  type Advice,
  adviseReuse,
  checkImports,
  declaredOnDisk,
  FUNCTION_LIKE_KINDS,
  findDuplicates,
  type GantryConfig,
  hashSymbol,
  nearScore,
  type ParsedFile,
  parseSource,
  pathOfFileId,
  type Store,
  type SymbolRecord,
  workspaceForPath,
} from "@gantry/core";

/**
 * Findings shared by the PostToolUse hook and pre-commit (spec sections 14 and 18). Output carries names,
 * paths, tiers, scores and actions only: never a function body and never a stored description.
 */
export interface DupFinding {
  kind: "duplicate";
  /** Symbol ids of the new function and the match: used by the double-check, never printed. */
  symbolId: string;
  existingId: string;
  name: string;
  path: string;
  line: number;
  existing: string;
  existingPath: string;
  existingLine: number;
  tier: string;
  score: number;
  action: string;
  /** The advice behind `action` is `inline: true` (spec section 18). */
  inline: boolean;
}
export interface ImportLine {
  kind: "import";
  line: number;
  action: string;
  /** The package and the package.json files that would declare it (workspace, then root): used by the double-check. */
  pkg: string;
  manifests: string[];
}
export type Finding = DupFinding | ImportLine;

/** Matches listed per symbol (spec section 14). */
const PER_SYMBOL = 2;

const FUNCTION_LIKE = new Set<string>(FUNCTION_LIKE_KINDS);

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

function pickAction(advice: Advice[]): { action: string; inline: boolean } {
  const a = advice.find((x) => x.inline) ?? advice[0];
  return a
    ? { action: oneLine(a.action), inline: a.inline }
    : { action: "Reuse it instead of adding a copy", inline: false };
}

/** Function-like symbols of `file` that are new or whose exactHash differs from `previous` (id to hash). */
export function changedSymbols(current: SymbolRecord[], previous: Map<string, string>): SymbolRecord[] {
  return current.filter(
    (s) => FUNCTION_LIKE.has(s.kind) && s.exactHash !== "" && previous.get(s.id) !== s.exactHash,
  );
}

/**
 * Duplicate findings for the given (already indexed) symbols, exact + near + code_vector (stored vectors
 * only: the engine never loads a model). `limit` 2 per symbol, newest (lowest in the file) first.
 */
export async function duplicateFindings(
  store: Store,
  symbols: SymbolRecord[],
  config: GantryConfig,
  keep?: (f: DupFinding) => boolean,
): Promise<DupFinding[]> {
  const out: DupFinding[] = [];
  const ordered = [...symbols].sort((a, b) => b.startLine - a.startLine || (a.id < b.id ? -1 : 1));
  for (const sym of ordered) {
    const callerPath = pathOfFileId(sym.fileId);
    const cands = await findDuplicates(
      store,
      { symbol: sym },
      { tiers: ["exact", "near", "code_vector"], limit: keep ? 2 * PER_SYMBOL : PER_SYMBOL, config },
    );
    const mine: DupFinding[] = [];
    for (const c of cands) {
      const match = store.getSymbol(c.symbolId);
      if (!match) continue;
      mine.push({
        kind: "duplicate",
        symbolId: sym.id,
        existingId: match.id,
        name: sym.name,
        path: callerPath,
        line: sym.startLine,
        existing: match.name,
        existingPath: pathOfFileId(match.fileId),
        existingLine: match.startLine,
        tier: c.tier,
        score: c.score,
        ...pickAction(adviseReuse(store, callerPath, match, null, config)),
      });
    }
    // One clear instruction beats a list: when a copy can simply be imported, do not also list the others.
    // The double-check runs before the top two are chosen, so a dropped match makes room for the next one.
    const kept = (keep ? mine.filter(keep) : mine).slice(0, PER_SYMBOL);
    out.push(...(kept.some((f) => f.inline) ? kept.filter((f) => f.inline) : kept));
  }
  return out;
}

/**
 * Import findings for `parsed` that are not already present in `before` (the previous version of the file),
 * so only imports added by this change are reported.
 */
export function importFindings(
  store: Store,
  filePath: string,
  parsed: ParsedFile,
  before?: ParsedFile,
): ImportLine[] {
  const now = checkImports(store, filePath, parsed);
  const old = new Set(
    before ? checkImports(store, filePath, before).map((f) => `${f.specifier}\0${f.kind}`) : [],
  );
  const all = store.listWorkspaces();
  const ws = all.length > 0 ? workspaceForPath(all, filePath) : undefined;
  const manifests = [ws && ws.dir !== "." ? `${ws.dir}/package.json` : "", "package.json"].filter(Boolean);
  return now
    .filter((f) => !old.has(`${f.specifier}\0${f.kind}`))
    .map((f) => ({
      kind: "import" as const,
      line: f.line,
      action: oneLine(f.action),
      pkg: f.pkg,
      manifests: f.kind === "undeclared" ? manifests : [],
    }));
}

/**
 * Double-check against disk, just before findings are shown (spec section 14). A duplicate is kept only while the
 * matched function is still in its file on disk and still matches: unchanged, or (when it changed) still exact or
 * near at the configured thresholds; a changed code_vector match is dropped, as its vector cannot be recomputed
 * here. That drops the first half of a move once the old copy is gone. An undeclared-import finding is dropped when
 * the workspace's or the root's package.json on disk now declares the package. Failing checks are silent.
 */
export function verifyFindings(
  root: string,
  store: Store,
  findings: Finding[],
  config: GantryConfig,
): Finding[] {
  return findings.filter(diskCheck(root, store, config));
}

/** The double-check of `verifyFindings` as a predicate, with the files it reads cached for its lifetime. */
export function diskCheck(root: string, store: Store, config: GantryConfig): (f: Finding) => boolean {
  const files = new Map<string, { parsed: ParsedFile; source: string } | null>();
  const read = (rel: string): { parsed: ParsedFile; source: string } | null => {
    let v = files.get(rel);
    if (v === undefined) {
      try {
        const source = fs.readFileSync(path.join(root, rel), "utf8");
        v = { parsed: parseSource(store.repo(), rel, source), source };
      } catch {
        v = null;
      }
      files.set(rel, v);
    }
    return v;
  };
  const manifests = new Map<string, string[] | undefined>();
  const declared = (m: string): string[] | undefined => {
    if (!manifests.has(m)) manifests.set(m, declaredOnDisk(root, m));
    return manifests.get(m);
  };
  return (f) => {
    if (f.kind === "import") return !f.manifests.some((m) => declared(m)?.includes(f.pkg));
    const disk = read(f.existingPath);
    const range = disk?.parsed.bodies.get(f.existingId);
    if (!disk || !range || !disk.parsed.symbols.some((s) => s.id === f.existingId)) return false;
    const fresh = hashSymbol(disk.source, range, f.existingPath.endsWith("x") ? "tsx" : "ts");
    const stored = store.getSymbol(f.existingId);
    if (stored && stored.exactHash === fresh.exactHash) return true;
    const mine = store.getSymbol(f.symbolId);
    if (!mine) return false;
    if (fresh.exactHash === mine.exactHash) return true;
    if (f.tier === "exact" && mine.renamedHash && fresh.renamedHash === mine.renamedHash) return true;
    if (f.tier === "code_vector") return false;
    return (
      nearScore(
        { ...mine, nearMinhash: mine.nearMinhash ?? new Uint32Array(0) },
        fresh,
        config.duplicates.thresholds,
      ) !== null
    );
  };
}

const score = (n: number): string => n.toFixed(2);

/** One finding as one line. */
export function formatFinding(f: Finding): string {
  if (f.kind === "import") return `Gantry: ${f.action} (line ${f.line})`;
  return (
    `Gantry: ${f.name} (${f.path}:${f.line}) looks like ${f.existing} in ${f.existingPath}:${f.existingLine} ` +
    `[${f.tier} ${score(f.score)}]. ${f.action}`
  );
}

/** Lines joined with newlines, whole lines only, at most `max` chars; a first line that is too long is cut. */
export function formatCapped(findings: Finding[], max = 600): string {
  let out = "";
  for (const f of findings) {
    const line = formatFinding(f);
    const next = out === "" ? line : `${out}\n${line}`;
    if (next.length <= max) {
      out = next;
      continue;
    }
    if (out === "") out = `${line.slice(0, max - 1)}…`;
    break;
  }
  return out;
}

/** Pre-commit: no character cap, at most `maxLines` lines. */
export function formatLines(findings: Finding[], maxLines = 10): string[] {
  return findings.slice(0, maxLines).map(formatFinding);
}

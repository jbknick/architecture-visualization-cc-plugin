import {
  type Advice,
  adviseReuse,
  checkImports,
  FUNCTION_LIKE_KINDS,
  findDuplicates,
  type GantryConfig,
  type ParsedFile,
  pathOfFileId,
  type Store,
  type SymbolRecord,
} from "@gantry/core";

/**
 * Findings shared by the PostToolUse hook and pre-commit (spec sections 14 and 18). Output carries names,
 * paths, tiers, scores and actions only: never a function body and never a stored description.
 */
export interface DupFinding {
  kind: "duplicate";
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
}
export type Finding = DupFinding | ImportLine;

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
): Promise<DupFinding[]> {
  const out: DupFinding[] = [];
  const ordered = [...symbols].sort((a, b) => b.startLine - a.startLine || (a.id < b.id ? -1 : 1));
  for (const sym of ordered) {
    const callerPath = pathOfFileId(sym.fileId);
    const cands = await findDuplicates(
      store,
      { symbol: sym },
      { tiers: ["exact", "near", "code_vector"], limit: 2, config },
    );
    const mine: DupFinding[] = [];
    for (const c of cands) {
      const match = store.getSymbol(c.symbolId);
      if (!match) continue;
      mine.push({
        kind: "duplicate",
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
    out.push(...(mine.some((f) => f.inline) ? mine.filter((f) => f.inline) : mine));
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
  return now
    .filter((f) => !old.has(`${f.specifier}\0${f.kind}`))
    .map((f) => ({ kind: "import" as const, line: f.line, action: oneLine(f.action) }));
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

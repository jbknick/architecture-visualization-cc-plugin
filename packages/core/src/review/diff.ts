import { spawnSync } from "node:child_process";
import { loadConfig } from "../config/index.js";
import { isIndexable, MAX_FILE_BYTES } from "../discover/index.js";
import { hashSymbol } from "../hash/index.js";
import { parseSource } from "../parse/index.js";
import type { GantryPaths } from "../paths/index.js";
import type { SymbolKind } from "../types.js";

/** One side of a changed symbol. */
export interface SymbolSide {
  id: string;
  path: string;
  line: number;
  signature: string;
  exactHash: string;
  /** Added for #43 (impact and risk read them from the diff, not from a store that may sit on another commit). */
  kind: SymbolKind;
  exported: boolean;
  complexity: number;
}

export interface SymbolChange {
  /** The id after the change (`after.id`), or `before.id` for a removed symbol. */
  id: string;
  kind: "added" | "removed" | "modified" | "moved" | "renamed";
  before?: SymbolSide;
  after?: SymbolSide;
  signatureChanged: boolean;
  exportedChanged: boolean;
  /** Lines after minus lines before (a whole body counts for an added or removed symbol). */
  locDelta: number;
}

export interface ReviewFile {
  path: string;
  status: "A" | "M" | "D" | "R";
}

export interface ReviewDiff {
  base: string;
  head: string;
  mergeBase: string;
  files: ReviewFile[];
  changes: SymbolChange[];
  importChanges: { path: string; added: string[]; removed: string[] }[];
}

const GIT_MAX_BUFFER = 512 * 1024 * 1024;

function git(root: string, args: string[]): { ok: boolean; out: Buffer; err: string } {
  const r = spawnSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd: root,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: r.status === 0,
    out: r.stdout ?? Buffer.alloc(0),
    err: (r.stderr ?? Buffer.alloc(0)).toString("utf8"),
  };
}

/** The text of `path` at `ref` (`git show`), or undefined when it is missing, not text or too large to index. */
export function readBlobText(root: string, ref: string, path: string): string | undefined {
  const r = git(root, ["show", `${ref}:${path}`]);
  if (!r.ok || r.out.length > MAX_FILE_BYTES) return undefined;
  return r.out.toString("utf8");
}

function resolveCommit(root: string, ref: string): string {
  if (ref === "" || ref.startsWith("-")) throw new Error(`invalid git ref: "${ref}"`);
  const r = git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  const sha = r.out.toString("utf8").trim();
  if (!r.ok || sha === "") throw new Error(`unknown git ref: ${ref}`);
  return sha;
}

interface ChangedFile {
  status: "A" | "M" | "D" | "R";
  /** Path at the merge base (absent for an added file). */
  oldPath?: string;
  /** Path at head (absent for a deleted file). */
  newPath?: string;
}

function parseNameStatus(raw: string): ChangedFile[] {
  const parts = raw.split("\0");
  const out: ChangedFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++] ?? "";
    if (code === "") continue;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const from = parts[i++] ?? "";
      const to = parts[i++] ?? "";
      // A copy leaves the source in place: for symbols it is an added file.
      out.push(letter === "R" ? { status: "R", oldPath: from, newPath: to } : { status: "A", newPath: to });
    } else {
      const p = parts[i++] ?? "";
      if (letter === "A") out.push({ status: "A", newPath: p });
      else if (letter === "D") out.push({ status: "D", oldPath: p });
      else out.push({ status: "M", oldPath: p, newPath: p }); // M, T
    }
  }
  return out;
}

interface Sym extends SymbolSide {
  name: string;
  renamedHash: string;
  loc: number;
}

interface Side {
  symbols: Sym[];
  imports: Set<string>;
}

const EMPTY: Side = { symbols: [], imports: new Set() };

/** Parses the blob of `path` at `sha` in memory. Undefined when it cannot be read or is too large to index. */
function readSide(root: string, sha: string, path: string): Side | undefined {
  const r = git(root, ["show", `${sha}:${path}`]);
  if (!r.ok || r.out.length > MAX_FILE_BYTES) return undefined;
  const source = r.out.toString("utf8");
  const parsed = parseSource(path, source);
  const lang = path.endsWith(".tsx") ? "tsx" : "ts";
  const symbols: Sym[] = parsed.symbols.map((s) => {
    const body = parsed.bodies.get(s.id);
    const h = body ? hashSymbol(source, body, lang) : { exactHash: "", renamedHash: "" };
    return {
      id: s.id,
      path,
      line: s.startLine,
      signature: s.signature,
      exactHash: h.exactHash,
      name: s.name,
      renamedHash: h.renamedHash,
      exported: s.exported,
      kind: s.kind,
      complexity: s.complexity,
      loc: s.loc,
    };
  });
  return { symbols, imports: new Set(parsed.imports.map((i) => i.specifier)) };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sideOf = (s: Sym): SymbolSide => ({
  id: s.id,
  path: s.path,
  line: s.line,
  signature: s.signature,
  exactHash: s.exactHash,
  kind: s.kind,
  exported: s.exported,
  complexity: s.complexity,
});

function change(kind: SymbolChange["kind"], before?: Sym, after?: Sym): SymbolChange {
  return {
    id: (after ?? before)?.id as string,
    kind,
    ...(before ? { before: sideOf(before) } : {}),
    ...(after ? { after: sideOf(after) } : {}),
    signatureChanged: before !== undefined && after !== undefined && before.signature !== after.signature,
    exportedChanged: before !== undefined && after !== undefined && before.exported !== after.exported,
    locDelta: (after?.loc ?? 0) - (before?.loc ?? 0),
  };
}

/**
 * Symbol-level diff between the merge base of `base` and `head` and `head` (spec section 11, "Review diff"). Reads
 * only the changed files' blobs with `git show`, parses them in memory, and writes nothing: not the store, not the
 * working tree. The result is sorted and deterministic: no timing and no machine-specific value.
 */
export async function reviewDiff(paths: GantryPaths, base: string, head: string): Promise<ReviewDiff> {
  const root = paths.root;
  const baseSha = resolveCommit(root, base);
  const headSha = resolveCommit(root, head);
  const mb = git(root, ["merge-base", baseSha, headSha]);
  const mergeBase = mb.out.toString("utf8").trim();
  if (!mb.ok || mergeBase === "") throw new Error(`no merge base between ${base} and ${head}`);

  const config = loadConfig(paths);
  const ns = git(root, ["diff", "--name-status", "-z", "-M", mergeBase, headSha]);
  if (!ns.ok) throw new Error(`git diff failed: ${ns.err.trim()}`);
  const changed = parseNameStatus(ns.out.toString("utf8")).filter((f) =>
    [f.oldPath, f.newPath].some((p) => p !== undefined && isIndexable(p, config)),
  );

  const files: ReviewFile[] = [];
  const before = new Map<string, Sym>();
  const after = new Map<string, Sym>();
  const importChanges: ReviewDiff["importChanges"] = [];
  /** Renamed files: old path -> new path, for pairing leftover symbols by name. */
  const renamed = new Map<string, string>();

  for (const f of changed) {
    const path = (f.newPath ?? f.oldPath) as string;
    const b = f.oldPath !== undefined ? readSide(root, mergeBase, f.oldPath) : EMPTY;
    const a = f.newPath !== undefined ? readSide(root, headSha, f.newPath) : EMPTY;
    if (!a || !b) continue; // unreadable or too large to index: not a symbol-level change
    files.push({ path, status: f.status });
    if (f.status === "R") renamed.set(f.oldPath as string, f.newPath as string);
    for (const s of b.symbols) before.set(s.id, s);
    for (const s of a.symbols) after.set(s.id, s);
    const added = [...a.imports].filter((x) => !b.imports.has(x)).sort(cmp);
    const removed = [...b.imports].filter((x) => !a.imports.has(x)).sort(cmp);
    if (added.length > 0 || removed.length > 0) importChanges.push({ path, added, removed });
  }

  const changes: SymbolChange[] = [];
  const removed: Sym[] = [];
  for (const id of [...before.keys()].sort(cmp)) {
    const b = before.get(id) as Sym;
    const a = after.get(id);
    if (!a) {
      removed.push(b);
      continue;
    }
    if (a.exactHash !== b.exactHash || a.signature !== b.signature || a.exported !== b.exported) {
      changes.push(change("modified", b, a));
    }
  }
  const added = [...after.keys()]
    .filter((id) => !before.has(id))
    .sort(cmp)
    .map((id) => after.get(id) as Sym);

  // Pair what is left. Same code first (exact, then with the symbol's own name masked), same file before another
  // file; then, inside a renamed file, same name.
  const takenAdded = new Set<Sym>();
  const takenRemoved = new Set<Sym>();
  const pair = (
    match: (r: Sym, a: Sym) => boolean,
    kindOf: (r: Sym, a: Sym) => SymbolChange["kind"],
  ): void => {
    for (const r of removed) {
      if (takenRemoved.has(r)) continue;
      const cands = added.filter((a) => !takenAdded.has(a) && match(r, a));
      const a = cands.find((c) => c.path === r.path) ?? cands[0];
      if (!a) continue;
      takenRemoved.add(r);
      takenAdded.add(a);
      changes.push(change(kindOf(r, a), r, a));
    }
  };
  const kindByPath = (r: Sym, a: Sym): SymbolChange["kind"] => (r.path === a.path ? "renamed" : "moved");
  pair((r, a) => r.exactHash !== "" && r.exactHash === a.exactHash, kindByPath);
  pair((r, a) => r.renamedHash !== "" && r.renamedHash === a.renamedHash, kindByPath);
  pair(
    (r, a) => r.name === a.name && renamed.get(r.path) === a.path,
    () => "moved",
  );

  for (const r of removed) if (!takenRemoved.has(r)) changes.push(change("removed", r, undefined));
  for (const a of added) if (!takenAdded.has(a)) changes.push(change("added", undefined, a));

  changes.sort(
    (x, y) => cmp(x.id, y.id) || cmp(x.kind, y.kind) || cmp(x.before?.id ?? "", y.before?.id ?? ""),
  );
  files.sort((x, y) => cmp(x.path, y.path));
  importChanges.sort((x, y) => cmp(x.path, y.path));
  return { base, head, mergeBase, files, changes, importChanges };
}

/**
 * The commits a review of `base`...`head` compares: the merge base and the head commit sha. Cheap (two
 * `rev-parse` calls and one `merge-base`), so a caller can key a cache on it before running `reviewDiff`.
 */
export function reviewCommits(
  paths: GantryPaths,
  base: string,
  head: string,
): { mergeBase: string; head: string } {
  const baseSha = resolveCommit(paths.root, base);
  const headSha = resolveCommit(paths.root, head);
  const mb = git(paths.root, ["merge-base", baseSha, headSha]);
  const mergeBase = mb.out.toString("utf8").trim();
  if (!mb.ok || mergeBase === "") throw new Error(`no merge base between ${base} and ${head}`);
  return { mergeBase, head: headSha };
}

/** Ranges are `base...head` (merge-base form) or `base..head`; both mean the same here. */
export function parseRange(range: string): { base: string; head: string } {
  const m = /^(.+?)\.{2,3}(.+)$/.exec(range);
  if (!m) throw new Error(`expected <base>...<head>, got "${range}"`);
  return { base: m[1] as string, head: m[2] as string };
}

/**
 * Resolves `--pr <n>` to refs with `gh pr view <n> --json baseRefName,headRefOid`, fetching either one from
 * `origin` when the repository does not have it yet (a fetch writes into `.git`, never into the working tree).
 */
export function resolvePullRequest(paths: GantryPaths, n: number): { base: string; head: string } {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid pull request number: ${n}`);
  const root = paths.root;
  const r = spawnSync("gh", ["pr", "view", String(n), "--json", "baseRefName,headRefOid"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const range = "use the range form instead: gantry review <base>...<head>";
  if (r.error) throw new Error(`cannot run gh (${r.error.message}); ${range}`);
  if (r.status !== 0)
    throw new Error(`gh pr view ${n} failed (${r.stderr.trim() || `exit ${r.status}`}); ${range}`);
  let info: { baseRefName?: string; headRefOid?: string };
  try {
    info = JSON.parse(r.stdout) as typeof info;
  } catch {
    throw new Error(`gh pr view ${n} returned unreadable output; ${range}`);
  }
  const { baseRefName, headRefOid } = info;
  if (!baseRefName || !headRefOid || !/^[0-9a-f]{40,64}$/.test(headRefOid)) {
    throw new Error(`gh pr view ${n} returned no base or head; ${range}`);
  }
  if (baseRefName.startsWith("-")) throw new Error(`invalid base branch name from gh: ${baseRefName}`);

  const has = (ref: string): boolean => git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok;
  let base = `origin/${baseRefName}`;
  if (!has(base)) {
    const f = git(root, ["fetch", "--quiet", "origin", `${baseRefName}:refs/remotes/origin/${baseRefName}`]);
    if (!f.ok) throw new Error(`could not fetch ${baseRefName} from origin: ${f.err.trim()}; ${range}`);
  }
  if (!has(base)) base = baseRefName;
  if (!has(headRefOid)) {
    const f = git(root, ["fetch", "--quiet", "origin", `pull/${n}/head`]);
    if (!f.ok || !has(headRefOid))
      throw new Error(`could not fetch the head of PR #${n}: ${f.err.trim()}; ${range}`);
  }
  return { base, head: headRefOid };
}

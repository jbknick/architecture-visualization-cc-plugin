import { isAbsolute, relative } from "node:path";
import {
  adviseReuse,
  behaviorMap,
  contentKey,
  describedByOf,
  descriptionOf,
  FUNCTION_LIKE_KINDS,
  findDuplicatesDetailed,
  hybridSearch,
  knn,
  LANG_IDS,
  type Lang,
  loadConfigForDb,
  pathOfFileId,
  repoOfId,
  type Store,
  type SymbolKind,
  type SymbolRecord,
  TIER_RANK,
  type Tier,
} from "@gantry/core";
import { z } from "zod";
import { defineTool } from "../tool.js";
import { describedByField, untrustedField } from "../untrusted.js";

const KINDS = [
  "function",
  "method",
  "component",
  "hook",
  "class",
  "type",
  "interface",
  "enum",
  "const",
] as const satisfies readonly SymbolKind[];
const SIGNATURE_MAX = 200;
const MAX_CODE_CHARS = 20_000;
const POOL = 10;
const NO_VECTORS =
  "meaning search unavailable (no description vectors or embedding model); showing code and keyword matches only";

interface Found {
  tier: Tier;
  score: number;
  /** Inside the semantic tier a measured cosine ranks above a keyword-only hit. */
  measured: boolean;
}

const order = (a: Found, b: Found): number =>
  TIER_RANK[a.tier] - TIER_RANK[b.tier] || Number(b.measured) - Number(a.measured) || b.score - a.score;

/** The caller path adviseReuse should use: repo-relative posix, "." (the repo root) when unknown or outside the repo. */
function callerPathOf(root: string, given: string | undefined): string {
  if (!given) return ".";
  const rel = isAbsolute(given) ? relative(root, given) : given;
  const posix = rel.split("\\").join("/").replace(/^\.\//, "");
  return posix === "" || posix.startsWith("..") ? "." : posix;
}

function scopeFilter(
  store: Store,
  kind: string | undefined,
  lang: Lang | undefined,
  workspace: string | undefined,
): ((s: SymbolRecord) => boolean) | null {
  let workspaceId: string | undefined;
  if (workspace !== undefined) {
    workspaceId = store.listWorkspaces().find((w) => w.id === workspace || w.name === workspace)?.id;
    if (workspaceId === undefined) return null;
  }
  const files = new Map(store.effectiveFiles().map((f) => [f.id, f]));
  return (s) => {
    if (kind !== undefined && s.kind !== kind) return false;
    if (lang !== undefined && s.lang !== lang) return false;
    const file = files.get(s.fileId);
    if (!file || file.deleted) return false;
    return workspaceId === undefined || file.workspaceId === workspaceId;
  };
}

export const findSimilarTool = defineTool({
  name: "gantry_find_similar",
  description:
    "Call this before writing a new helper, hook or component: it looks for code that already does the same thing. " +
    "Give query (one sentence on what you are about to write), code (a draft), or both. " +
    "Returns {matches: [{id, repo, name, kind, lang, path, line, signature, import_path, tier, score, untrusted_description, advice: {situation, action, inline, untrusted_suggested_name?} | null}]}, best first: tier exact, near, code_vector (a draft matches in code), semantic (a query matches in meaning or words). " +
    "A match can be in another repo of the workspace (its repo says which; path is relative to that repo); the advice then says so, and is an import line only when the caller's workspace already depends on the package that holds the match. " +
    "advice.inline true means the match can be imported as is (advice.action has the import line); otherwise advice.action is a suggestion for the user. " +
    "Without description vectors meaning search is skipped and the payload says so in notes. Read the file before relying on a match. Responses are capped at 4,000 characters (truncated: true).",
  inputSchema: {
    query: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe("One sentence on what the code you are about to write does"),
    code: z
      .string()
      .min(1)
      .max(MAX_CODE_CHARS)
      .optional()
      .describe(
        "A draft of the code: TypeScript, TSX or Go (Go when lang is go or caller_path is a .go file)",
      ),
    kind: z.enum(KINDS).optional().describe("Restrict matches to this symbol kind"),
    lang: z
      .enum(LANG_IDS as [Lang, ...Lang[]])
      .optional()
      .describe("Restrict matches to one language"),
    workspace: z.string().max(200).optional().describe("Workspace id (ws:...) or name"),
    caller_path: z
      .string()
      .max(500)
      .optional()
      .describe(
        "The file you are editing, repo-relative, so the import advice is right; default is the repo root",
      ),
    limit: z.number().int().min(1).max(10).default(5).describe("Maximum matches, at most 10"),
  },
  async run(
    { query, code, kind, lang, workspace, caller_path, limit },
    { store, paths, getEmbedder, env: ctxEnv },
  ) {
    if (query === undefined && code === undefined) {
      return { error: "invalid_input", message: "Give query, code, or both.", matches: [] };
    }
    const inScope = scopeFilter(store, kind, lang, workspace);
    if (!inScope) return { matches: [], notes: ["unknown workspace"] };
    const notes: string[] = [];
    const found = new Map<string, Found>();
    const add = (id: string, f: Found): void => {
      const prev = found.get(id);
      if (!prev || order(f, prev) < 0) found.set(id, f);
    };

    if (code !== undefined) {
      const dialect = /<\/?[A-Za-z][^>]*>/.test(code) ? "tsx" : "ts";
      // A draft is Go when the caller says so (`lang`) or is editing a Go file; it is then compared with Go only.
      const isGo = lang === "go" || (lang === undefined && (caller_path ?? "").endsWith(".go"));
      const r = await findDuplicatesDetailed(
        store,
        { code: { source: code, lang: dialect, ...(isGo ? { path: "scratch.go" } : {}) } },
        { limit: POOL },
      );
      for (const c of r.candidates) add(c.symbolId, { tier: c.tier, score: c.score, measured: true });
      for (const s of r.skipped) if (!notes.includes(s.message)) notes.push(s.message);
    }

    if (query !== undefined) {
      const embedder = await getEmbedder();
      let vectors = false;
      if (embedder && embedder.available !== false) {
        try {
          const [vec] = await embedder.embed([query], "query");
          if (vec && !vec.every((x) => x === 0)) {
            const near = knn(store, "vec_descriptions", vec, POOL);
            vectors = near.length > 0;
            const byKey = new Map(near.map((n) => [n.contentKey, n.cosine]));
            for (const s of store.effectiveSymbols({ kind: [...FUNCTION_LIKE_KINDS] })) {
              const cos = s.exactHash === "" ? undefined : byKey.get(contentKey(s.exactHash));
              if (cos !== undefined) add(s.id, { tier: "semantic", score: cos, measured: true });
            }
          }
        } catch {
          // fall through to the keyword half
        }
      }
      if (!vectors) notes.push(NO_VECTORS);
      const hits = await hybridSearch(store, query, {
        ...(kind ? { kind: [kind] } : {}),
        ...(lang !== undefined ? { lang } : {}),
        ...(workspace !== undefined ? { workspace } : {}),
        limit: POOL,
        ...(embedder ? { embedder } : {}),
      });
      for (const h of hits) add(h.id, { tier: "semantic", score: h.score, measured: false });
    }

    const behaviors = behaviorMap(store);
    const caller = callerPathOf(paths.root, caller_path);
    const rows: { sym: SymbolRecord; f: Found }[] = [];
    for (const [id, f] of found) {
      const sym = store.getSymbol(id);
      if (sym && inScope(sym)) rows.push({ sym, f });
    }
    rows.sort((a, b) => order(a.f, b.f) || (a.sym.id < b.sym.id ? -1 : a.sym.id > b.sym.id ? 1 : 0));

    const config = loadConfigForDb(paths.dbPath, ctxEnv);
    const matches = rows.slice(0, limit).map(({ sym, f }) => {
      const top = adviseReuse(
        store,
        caller,
        sym,
        config.renameSuggestions ? descriptionOf(store, sym) : null,
        config,
        paths.repo,
      )[0];
      const description = sym.exactHash === "" ? null : (behaviors.get(contentKey(sym.exactHash)) ?? null);
      return {
        id: sym.id,
        repo: repoOfId(sym.id),
        name: sym.name,
        kind: sym.kind,
        lang: sym.lang,
        path: pathOfFileId(sym.fileId),
        line: sym.startLine,
        signature: sym.signature.slice(0, SIGNATURE_MAX),
        import_path: top?.importPath ?? null,
        tier: f.tier,
        score: Number(f.score.toFixed(4)),
        ...untrustedField(description),
        ...(description !== null ? describedByField(describedByOf(store, sym)) : {}),
        advice: top
          ? {
              situation: top.situation,
              action: top.action,
              inline: top.inline,
              ...(top.untrusted_suggested_name === undefined
                ? {}
                : { untrusted_suggested_name: top.untrusted_suggested_name }),
            }
          : null,
      };
    });
    return { matches, ...(notes.length > 0 ? { notes } : {}) };
  },
});

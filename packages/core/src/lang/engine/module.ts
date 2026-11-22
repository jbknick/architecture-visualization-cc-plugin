import picomatch from "picomatch";
import { pathOfFileId } from "../../ids.js";
import type { ParsedFile } from "../../parse/index.js";
import type { ResolveContext, Resolver } from "../../resolve/index.js";
import type { EdgeRecord, Lang } from "../../types.js";
import type { LanguageModule } from "../index.js";
import { grammarAvailable } from "./grammar.js";
import type { LanguagePack } from "./pack.js";
import { parseWithPack } from "./parse.js";
import { nameCallResolver, typeCallResolver, workspaceOfPath } from "./resolve/index.js";
import { embeddingTextWithPack, streamsWithPack } from "./streams.js";
import { detectPackWorkspaces, manifestFiles, packDependsOnEdges } from "./workspace.js";

/** What resolves calls: the `calls` edges (and, for a language that has them, `extends` and `implements`) and the targets behind them. */
export interface CallResolver {
  targetAt: NonNullable<Resolver["targetAt"]>;
  typeNameAt: NonNullable<Resolver["typeNameAt"]>;
  edgesForFile(fileId: string, parsed: ParsedFile): EdgeRecord[];
}

export type CallResolverFactory = (ctx: ResolveContext) => CallResolver;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The resolver of a pack: file and symbol `contains` edges and the `depends_on` edges between workspaces come from the
 * pack; call edges and targets come from `calls`. Imports are not specifiers of a file, so `resolveSpecifier` has
 * nothing to resolve; the call resolver reads them itself.
 */
function createPackResolver(pack: LanguagePack, calls: CallResolverFactory, ctx: ResolveContext): Resolver {
  let callResolver: CallResolver | undefined;
  const callsOf = (): CallResolver => {
    callResolver ??= calls(ctx);
    return callResolver;
  };
  return {
    resolveSpecifier: () => ({ kind: "unresolved" }),
    resolveSymbol: () => null,
    targetAt: (fileId, start, end) => callsOf().targetAt(fileId, start, end),
    typeNameAt: (fileId, start, end) => callsOf().typeNameAt(fileId, start, end),
    edgesForFile(fileId: string): EdgeRecord[] {
      const pf = ctx.parsed.get(fileId);
      if (!pf) return [];
      const rel = pathOfFileId(fileId);
      const best = workspaceOfPath(pack, ctx.workspaces, rel);
      const edge = (src: string, dst: string): EdgeRecord => ({
        src,
        dst,
        kind: "contains",
        confidence: "high",
        count: 1,
        evidence: [],
        fileId,
      });
      const out: EdgeRecord[] = [];
      if (best) out.push(edge(best.id, fileId));
      for (const s of pf.symbols) out.push(edge(fileId, s.id));
      out.push(...callsOf().edgesForFile(fileId, pf));
      return out.sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.kind, b.kind));
    },
    workspaceEdges: () => packDependsOnEdges(pack, ctx.repo, ctx.root, ctx.workspaces),
    stats: () => ({
      counts: {
        file: 0,
        external: 0,
        builtin: 0,
        virtual: 0,
        generated: 0,
        excluded: 0,
        ambiguous: 0,
        unresolved: 0,
      },
      unresolved: [],
    }),
  };
}

/**
 * The language module of a pack: file rules, workspace discovery, parsing, token streams, embedding text and the data
 * of the pack (labels, hints, thresholds). Calls are resolved from declared types (level 2) when the pack says where its
 * types sit (`nodes.typing`) and by names alone (level 1) otherwise; both are in `resolve/`. On a platform where the
 * grammar does not load the module claims no extension, so its files are skipped and the other languages are indexed.
 */
export function buildLanguage(pack: LanguagePack): LanguageModule {
  const calls: CallResolverFactory = pack.nodes.typing ? typeCallResolver(pack) : nameCallResolver(pack);
  const skip = picomatch([...pack.skipPaths], { dot: true });
  return {
    id: pack.id as Lang,
    label: pack.label,
    extensions: grammarAvailable(pack) ? pack.extensions : [],
    skipPath: (repoRelPath) => skip(repoRelPath),
    detectWorkspaces: (root, config, repo) => detectPackWorkspaces(pack, root, config, repo),
    manifestFiles: manifestFiles(pack),
    unreusable: pack.nodes.typing?.unnamed ?? [],
    parseSource: (repo, repoRelPath, source) => parseWithPack(pack, repo, repoRelPath, source),
    createResolver: (ctx) => createPackResolver(pack, calls, ctx),
    streams: (source, range) => streamsWithPack(pack, source, range),
    embeddingText: (source, range) => embeddingTextWithPack(pack, source, range),
    factSheetHints: pack.factSheetHints,
    kindLabels: pack.kindLabels,
    thresholds: pack.thresholds,
  };
}

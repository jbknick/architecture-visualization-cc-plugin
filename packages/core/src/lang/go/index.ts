import { pathOfFileId } from "../../ids.js";
import type { ResolveContext, Resolver } from "../../resolve/index.js";
import type { EdgeRecord, SymbolKind } from "../../types.js";
import type { LanguageModule } from "../index.js";
import { GoCalls } from "./calls.js";
import { goAvailable } from "./grammar.js";
import { goEmbeddingText, goStreams } from "./hash.js";
import { parseGoSource } from "./parse.js";
import { GoIndex } from "./resolve.js";
import { detectGoWorkspaces, goDependsOnEdges } from "./workspace.js";

const KIND_LABELS: Record<SymbolKind, string> = {
  function: "function",
  method: "method",
  component: "component",
  hook: "hook",
  class: "struct",
  type: "type",
  interface: "interface",
  enum: "enum",
  const: "const",
};

/** Go skips `vendor/`, `testdata/` and dot folders (the rules the Go tool applies). */
const skipGoPath = (repoRelPath: string): boolean =>
  repoRelPath
    .split("/")
    .some(
      (seg, i, all) => i < all.length - 1 && (seg === "vendor" || seg === "testdata" || seg.startsWith(".")),
    );

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The Go resolver: file and symbol `contains` edges, the `depends_on` edges between modules, and `calls`, `extends`
 * and `implements` edges from the package index and local type inference (`resolve.ts`, `calls.ts`). Go imports are
 * not specifiers of a file, so `resolveSpecifier` has nothing to resolve.
 */
function createGoResolver(ctx: ResolveContext): Resolver {
  let calls: GoCalls | undefined;
  const callsOf = (): GoCalls => {
    calls ??= new GoCalls(new GoIndex(ctx));
    return calls;
  };
  return {
    resolveSpecifier: () => ({ kind: "unresolved" }),
    resolveSymbol: () => null,
    edgesForFile(fileId: string): EdgeRecord[] {
      const pf = ctx.parsed.get(fileId);
      if (!pf) return [];
      const rel = pathOfFileId(fileId);
      let best: (typeof ctx.workspaces)[number] | undefined;
      for (const w of ctx.workspaces) {
        if (w.lang !== "go") continue;
        if (w.dir === "." || rel.startsWith(`${w.dir}/`)) {
          if (!best || (w.dir === "." ? 0 : w.dir.length) > (best.dir === "." ? 0 : best.dir.length))
            best = w;
        }
      }
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
    workspaceEdges: () => goDependsOnEdges(ctx.repo, ctx.root, ctx.workspaces),
    stats: () => ({
      counts: { file: 0, external: 0, builtin: 0, virtual: 0, generated: 0, excluded: 0, unresolved: 0 },
      unresolved: [],
    }),
  };
}

/**
 * The Go language module: tree-sitter Go through `@ast-grep/napi` (no Go toolchain), Go modules as workspaces.
 * On a platform without a Go prebuild it claims no extension, so Go files are skipped and TypeScript indexing goes on.
 */
export const go: LanguageModule = {
  id: "go",
  label: "Go",
  extensions: goAvailable() ? [".go"] : [],
  skipPath: skipGoPath,
  detectWorkspaces: detectGoWorkspaces,
  parseSource: parseGoSource,
  createResolver: createGoResolver,
  streams: goStreams,
  embeddingText: goEmbeddingText,
  factSheetHints: [],
  kindLabels: KIND_LABELS,
  thresholds: { exactMinStmts: 3, nearMinStmts: 6 },
};

import picomatch from "picomatch";
import type { SymbolKind } from "../../types.js";
import type { LanguageModule } from "../index.js";
import { CLOJURE_EXTENSIONS, CLOJURE_ID, CLOJURE_SKIP_PATHS } from "./ids.js";
import { parseClojure } from "./parse.js";
import { createClojureResolver } from "./resolve.js";
import { clojureEmbeddingText, clojureStreams } from "./streams.js";
import { detectClojureWorkspaces } from "./workspace.js";

const KIND_LABELS: Record<SymbolKind, string> = {
  function: "function",
  method: "method",
  component: "component",
  hook: "hook",
  class: "record",
  type: "type",
  interface: "protocol",
  enum: "enum",
  const: "var",
};

const skip = picomatch([...CLOJURE_SKIP_PATHS], { dot: true });

/**
 * The Clojure module (spec section 7, Clojure): `.clj`, `.cljs` and `.cljc` files read by a hand-written reader (no
 * grammar, no JVM, no Clojure tooling), workspaces from `project.clj`, `deps.edn`, `shadow-cljs.edn` and `bb.edn`, and
 * level 1 call edges resolved by namespace and names alone. It is a language module of its own, not a pack: the packs
 * are tables of tree-sitter node kinds, and no tree-sitter Clojure grammar is an approved dependency.
 */
export const clojure: LanguageModule = {
  id: CLOJURE_ID,
  label: "Clojure",
  extensions: [...CLOJURE_EXTENSIONS],
  skipPath: (p) => skip(p),
  detectWorkspaces: detectClojureWorkspaces,
  unreusable: [],
  parseSource: parseClojure,
  createResolver: createClojureResolver,
  streams: (source, range) => clojureStreams(source, range),
  embeddingText: (source, range) => clojureEmbeddingText(source, range),
  factSheetHints: [],
  kindLabels: KIND_LABELS,
  thresholds: { exactMinStmts: 3, nearMinStmts: 6 },
};

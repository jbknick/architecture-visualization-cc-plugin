/** The id and file rules of the Clojure module (spec section 7, Clojure kinds); a leaf module that imports nothing. */

export const CLOJURE_ID = "clojure";

/** Clojure, ClojureScript and the files read by both. */
export const CLOJURE_EXTENSIONS = [".clj", ".cljs", ".cljc"] as const;

/** Paths never indexed: build output and the caches of the tools. */
export const CLOJURE_SKIP_PATHS = [
  "**/target/**",
  "**/.cpcache/**",
  "**/.shadow-cljs/**",
  "**/.clj-kondo/**",
  "**/.lsp/**",
  "**/node_modules/**",
] as const;

/** Test files: a `test` folder, or a name that ends in `_test`. */
export const CLOJURE_TEST_PATTERNS = [
  "test/**",
  "**/test/**",
  "**/*_test.clj",
  "**/*_test.cljs",
  "**/*_test.cljc",
];

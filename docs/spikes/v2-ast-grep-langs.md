# Spike: ast-grep Go and Java grammar packages

V2 plan, M10. Question: is there a Go grammar package (and a Java one, for after V2) that loads on the `@ast-grep/napi` the spec approves, what are its exact name and version, and does it parse real files?

## Setup

- `@ast-grep/napi` is listed in spec section 2 (approved runtime dependencies) but **no package in the repo depends on it and no version is pinned** (`grep -rn ast-grep packages/*/package.json package.json` finds nothing). The spike used the latest release at the time, **0.51.3** (published 2026-11-16), with its platform package `@ast-grep/napi-darwin-arm64` 0.51.3.
- Grammar packages: `npm search @ast-grep/lang` lists one package per language from the ast-grep maintainer. Used: **`@ast-grep/lang-go` 0.0.6** (built from `tree-sitter-go` 0.25.0, published 2026-03-15) and **`@ast-grep/lang-java` 0.0.7** (built from `tree-sitter-java` 0.23.5, published 2026-03-15). Both depend on `@ast-grep/setup-lang` 0.0.6 and have an optional peer `tree-sitter-cli` 0.25.8 (only for building a parser where no prebuild exists).
- Installed in `docs/spikes/v2-ast-grep-langs/` with its own `package.json` (exact versions) and `npm install --no-audit --no-fund`; not part of the pnpm workspace, root manifests unchanged. Also installed with `pnpm add` (pnpm 10.31.0) in a scratch project outside the repo to check pnpm behaviour.
- Machine: Apple M3 Pro, macOS arm64, Node v26.13.0. No Go toolchain or JRE is needed (`java -version`: "Unable to locate a Java Runtime"; the Java grammar still loads and parses).
- Script: `pnpm tsx docs/spikes/v2-ast-grep-langs/run.ts --go <dir> --java <dir>`.
- Corpora (public, cloned to `/private/tmp/claude-501/gantry-spikes/`): `caddyserver/caddy` @ `7ce9f0823762109fc67911f95f6af1a697345ab7` (all 429 `.go` files, tests included); `spring-projects/spring-petclinic` @ `500158f732419217507c7656904b8e6aa1bcc0d6` (50 `.java` files).

## Results

| Check                                               | Go (`@ast-grep/lang-go` 0.0.6)                                                                                             | Java (`@ast-grep/lang-java` 0.0.7)                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Loads with `registerDynamicLanguage` on napi 0.51.3 | yes                                                                                                                        | yes                                                                                                 |
| Parser used                                         | `prebuilds/prebuild-macOS-ARM64/parser.so` (249 KB)                                                                        | `prebuilds/prebuild-macOS-ARM64/parser.so`                                                          |
| Prebuilds shipped                                   | macOS arm64/x64, Linux arm64/x64, Windows x64                                                                              | same                                                                                                |
| Inline sample: kinds and `field("name")`            | funcs `New`, methods `Total`, types `Cart`, `Store`; 0 ERROR nodes                                                         | class `OwnerController`, record `Pair`, method `show`; pattern `@GetMapping("$P")` captured `/{id}` |
| Real repo                                           | 429 files, 4,186 KiB, parse median **268 ms** (264/268/268), 0 files with ERROR nodes, 4,584 func/method/type declarations | 50 files, 138 KiB, parse median **7 ms**, 0 files with ERROR nodes, 245 declarations                |

Behaviour notes measured:

- **Install scripts are blocked and it still works.** npm 11 (`allowScripts`) and pnpm 10 (`Ignored build scripts: @ast-grep/lang-go@0.0.6, @ast-grep/lang-java@0.0.7`) both skip the `postinstall`. The packages resolve the prebuild at load time (`resolvePrebuild` in `index.js`), so on the five prebuilt platforms no script and no compiler is needed. On any other platform `index.js` throws "No parser found" unless the postinstall ran with `tree-sitter-cli` and a C compiler.
- **Platform gap.** `@ast-grep/napi` 0.51.3 has native builds for 9 targets (incl. `win32-arm64-msvc`, `win32-ia32-msvc`, `linux-*-musl`); the grammar packages have 5. Windows arm64 and ia32 have no Go/Java prebuild. The prebuild directory names do not say glibc or musl; Linux musl was not tested.
- **Calling `registerDynamicLanguage` twice** did not throw here, although its type docs say "call exactly once" and mark it `@experimental`. Production code should register once at module load.
- **Typing.** The grammar packages' default export is not typed as a `LangRegistration`; a cast is needed (`as unknown as DynamicLangRegistrations`). `parse("go", ...)` takes the language as a plain string.
- **Go pattern pitfall.** `findAll("fmt.Println($$$A)")` and `findAll("fmt.Println($A)")` match **0** of 2 calls; `fmt.Println($A, $B)` matches its one call, and the `{ context: "func _() { fmt.Println($$$A) }", selector: "call_expression" }` form matches both. A one-argument selector call alone does not parse as a call in tree-sitter-go (it reads like a conversion). The recipe spike hit the same issue.
- The rule kind `MISSING` is rejected by ast-grep ("Kind `MISSING` is invalid"); only `ERROR` nodes can be searched for, so a parse-error count misses inserted-missing tokens.

## Findings

1. **The Go package exists and works: `@ast-grep/lang-go` 0.0.6** on `@ast-grep/napi` 0.51.3. Java: **`@ast-grep/lang-java` 0.0.7.** Both parse real code with no errors and need no Go or Java toolchain.
2. **Pin both in spec section 2**, exactly: `@ast-grep/napi` (currently approved without a version or a user) and the grammar packages (new dependencies, need a section 2 edit). The grammar packages are at 0.0.x and were last published eight months before this spike; treat them as low-maintenance and keep a fixture test that fails if a grammar bump changes node kinds.
3. **Platforms:** document that Go support needs one of the five prebuilt targets, or a `tree-sitter-cli` build with install scripts allowed. Windows arm64 is the visible gap.
4. Go parse speed is about 1,600 files/s single-threaded on a real repo (test files included); `v2-go-parse.md` has the symbol accuracy and the walk cost.
5. Whoever writes Go recipe rules needs the pattern pitfalls above, and recipe validation should test each rule on example snippets.

## Deviations and notes

- The issue suggested "the pinned @ast-grep/napi"; none is pinned, so the latest release was used. An older napi was not tried.
- The script has no tests and is not referenced from the root `tsconfig.json`, so `tsc -b` and vitest do not see it; `pnpm biome check docs/spikes/v2-ast-grep-langs` passes.

**Verdict: go-with-changes.** Use `@ast-grep/lang-go` 0.0.6 (and later `@ast-grep/lang-java` 0.0.7) on `@ast-grep/napi` 0.51.3, with these changes: pin napi and the grammar packages exactly in spec section 2; register languages once at load; document the five supported platforms (no Windows arm64 prebuild); add a grammar-kind fixture test; put the Go pattern pitfalls into the discovery prompt.

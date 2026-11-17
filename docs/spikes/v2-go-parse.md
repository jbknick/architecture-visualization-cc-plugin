# Spike: tree-sitter Go symbols and parse speed (V2, M10)

Question: can tree-sitter Go, loaded through `@ast-grep/napi`, find every top-level Go symbol the V2 plan maps (function, method with receiver, struct as `class`, interface, type, const, var) as accurately as the Go compiler's own parser, and fast enough, with no Go toolchain on the user's machine?

Public repos only. Code: `docs/spikes/v2-go/` (`lib.ts`, `parse.ts`, ground truth in `truth/main.go`). Call edges on the same repos are in [v2-go-calls.md](v2-go-calls.md).

## Setup

- Machine: Apple M3 Pro, macOS arm64, Node v26.13.0, pnpm 10.31.0.
- Parser: `@ast-grep/napi` 0.51.3 (latest on npm, 2026-11-16) with `@ast-grep/lang-go` 0.0.6 (latest, 2026-03-15; built from `tree-sitter-go` 0.25.0, depends on `@ast-grep/setup-lang` 0.0.6). Installed in the spike's own `docs/spikes/v2-go/package.json` with `npm install --no-audit --no-fund` (not a pnpm workspace member, not in `tsconfig.json` references; `node_modules` is git-ignored). npm blocked the package's `postinstall` script, and it still loaded: the tarball ships prebuilt `parser.so` files for macOS arm64/x64, Linux arm64/x64 and Windows x64, and `postinstall` only builds from source (needs `tree-sitter-cli`) when no prebuild matches.
- Ground truth: `go/parser` + `go/ast` from Go 1.27.4 (Homebrew), every non-test `.go` file, all build tags; `golang.org/x/tools` v0.52.0 for the type-checked calls. `truth/` is its own Go module.
- Repos, cloned to `/private/tmp/claude-501/gantry-spikes/`:
  - `caddyserver/caddy` at `7ce9f0823762109fc67911f95f6af1a697345ab7` (2026-11-14): 429 `.go` files, 199 `_test.go`, **230 source files**, 2.5 MB.
  - `gohugoio/hugo` at `93be9f1f5b43446231ed3255b660cd7d3dd0ba11` (2026-11-17): 913 `.go` files, 394 `_test.go`, **519 source files**, 3.5 MB, 11 generated (`// Code generated ... DO NOT EDIT.`), 3 nested `go.mod` modules.
- File set: `git ls-files '*.go'` minus `_test.go`, `vendor/`, `testdata/` and dot folders (the same rules the Go tool applies).
- Commands (from the repo root):

  ```
  (cd docs/spikes/v2-go && npm install --no-audit --no-fund)
  (cd docs/spikes/v2-go/truth && go run . <repo> > <repo>-truth.json)
  pnpm tsx docs/spikes/v2-go/parse.ts <repo> <repo>-truth.json --runs 3
  ```
- Matching: a symbol is `(file, kind, receiver base type, name)`; line and exported flag are then compared on the matched pairs. Exported = first letter upper case.

## Results

| Metric                                            | caddy                    | hugo                     |
| ------------------------------------------------- | ------------------------ | ------------------------ |
| Source files parsed                               | 230                      | 519                      |
| Files with a tree-sitter `ERROR` node             | 0                        | 0                        |
| Files `go/parser` rejects                         | 0                        | 0                        |
| Parse, median of 3 (file reads excluded)          | 136 ms                   | 234 ms                   |
| Throughput                                        | 1,687 files/s, 18.2 MB/s | 2,220 files/s, 14.8 MB/s |
| Symbol walk over the tree (napi calls), median    | 71 ms                    | 138 ms                   |
| Symbols, go/ast truth                             | 3,599                    | 8,294                    |
| Symbols found                                     | 3,599                    | 8,294                    |
| **Precision / recall, all kinds**                 | **100% / 100%**          | **100% / 100%**          |
| Line and exported flag correct on matched symbols | 100%                     | 100%                     |
| Generated files detected (same regex as truth)    | 0 of 0                   | 11 of 11                 |

Per kind (truth = found = matched in every row, both repos):

| Kind (plan mapping)                                                                      | caddy | hugo  |
| ---------------------------------------------------------------------------------------- | ----- | ----- |
| `function` (func)                                                                        | 765   | 1,589 |
| `method` (func with receiver; receiver base type matched, incl. `*T` and generic `T[K]`) | 1,518 | 3,979 |
| `class` (struct)                                                                         | 390   | 889   |
| `interface`                                                                              | 66    | 320   |
| `type` (other named types and aliases)                                                   | 74    | 167   |
| `const`                                                                                  | 204   | 597   |
| `var`                                                                                    | 582   | 753   |

Runs within one process vary by under 3% (caddy 136/135/138 ms, hugo 234/227/239 ms); the first run is not slower, so there is no warm-up effect to hide.

### Stable IDs

ID tried: package directory + receiver + name, over all source files of a directory regardless of build tags (an indexer without the Go toolchain cannot evaluate `//go:build` for every platform).

|                                                                                                                   | caddy | hugo  |
| ----------------------------------------------------------------------------------------------------------------- | ----- | ----- |
| Distinct IDs                                                                                                      | 3,065 | 7,993 |
| IDs declared more than once                                                                                       | 14    | 6     |
| ... all explained by build constraints (`//go:build` or a `_windows.go`-style suffix on all but at most one file) | 14    | 6     |
| `_` and `init` symbols (never unique, excluded)                                                                   | 514   | 295   |

Caddy's 514 `_`/`init` are mostly interface guards (`var _ caddy.Module = (*X)(nil)`) plus module `init()` registrations.

## Findings

1. **Symbol extraction from tree-sitter Go is exact** on 11,893 symbols across two real repos: no misses, no extras, lines and exported flags all right. The plan's kind mapping (struct as `class`, receiver as `method`) is directly readable from node kinds: `function_declaration`, `method_declaration` (receiver in the `receiver` field), `type_spec` / `type_alias` with a `struct_type` / `interface_type` child, `const_spec` / `var_spec` (also under `var_spec_list`).
2. **One trap:** `fieldChildren("name")` on a `const_spec` also returns the `,` separators; filter to `identifier` nodes (cost 3 false symbols on caddy before the fix).
3. **Speed is not a concern.** About 2,000 files/s single-threaded for the parse, plus roughly half that again for a symbol walk through napi. A 10,000-file Go repo would parse in about 5 s and walk in about 3 s, single-threaded. Each napi call crosses into Rust, so walks should use `findAll` with kind rules rather than visiting every node from JS.
4. **Stable IDs need a build-constraint rule.** Package dir + receiver + name is unique except where the same function is declared in platform-specific files (`listen.go` / `listen_unix.go`). Every duplicate on both repos is of that kind. The ID scheme must either merge them into one symbol (with several locations) or add a disambiguator, and must exclude `_` and `init` (or number them).
5. **Generated files** are detected with the standard regex (11 of 11 on hugo); the plan's skip rule works as written.
6. **Packaging:** `@ast-grep/lang-go` is a 0.0.x package with a native `parser.so` per platform. There is no Windows arm64 prebuild in 0.0.6 (whether the Linux prebuilds load on musl was not tested); where none matches, install falls back to `postinstall`, which needs `tree-sitter-cli` and a C compiler, and pnpm 10 blocks dependency build scripts by default (`onlyBuiltDependencies`). Its TypeScript types do not cover dynamic languages: `field()` is typed for the built-in languages, so spike code casts field names (`"name" as never`) and does not pass `tsc --strict`. Production code needs a small typed wrapper.
7. Repos have nested modules (hugo has 3 extra `go.mod`). The plan's "each `go.mod` module is a workspace" handles them; the spike's call analysis (v2-go-calls) skips them, as `go/packages ./...` does.

## Deviations and notes

- Symbol truth uses `go/parser` on all files rather than `go/packages`, because `go/packages` only loads the files of the host's build (caddy: 211 of 230 files), and an indexer should see all of them.
- Speed is measured on two repos of 230 and 519 source files; the 10,000-file figure is an extrapolation, not a measurement.
- Only top-level symbols were compared. Methods on interfaces (`method_elem`), struct fields and nested function literals are not symbols in the plan and were not scored.
- The spike code is not type-checked by `tsc -b` (no reference in the root `tsconfig.json`, see Finding 6) and has no `*.test.ts`, so `pnpm check` does not depend on its npm-installed packages. `pnpm biome check docs/spikes/v2-go` passes.

**Verdict: go-with-changes.** Use tree-sitter Go through `@ast-grep/napi` 0.51.3 + `@ast-grep/lang-go` 0.0.6 for Go symbols, with these changes: (1) add `@ast-grep/lang-go` to spec section 2 with an exact pin, and pin `@ast-grep/napi` exactly too (it is approved but not yet a dependency of any package); (2) define stable Go IDs for symbols declared in several build-constrained files, and exclude `_` / number `init`; (3) wrap napi's field access in a small typed helper; (4) document the platforms without a prebuild (Windows arm64; Linux musl untested) or test the source-build path there.

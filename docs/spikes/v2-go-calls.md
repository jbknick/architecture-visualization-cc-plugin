# Spike: Go call edges from syntax alone vs go/packages (V2, M10)

Question: with tree-sitter Go only (no Go toolchain on the user's machine), how many call sites can an indexer resolve to the right in-repo callee, compared with the type-checked answer from `go/packages`? Is that good enough for duplicate warnings and impact analysis, or is the plan's fallback (an optional helper binary when a Go toolchain is present) needed?

Same repos, versions and file rules as [v2-go-parse.md](v2-go-parse.md). Code: `docs/spikes/v2-go/calls.ts` (syntax side), `docs/spikes/v2-go/truth/main.go` (truth).

## Setup

- Truth: `golang.org/x/tools/go/packages` v0.52.0 on Go 1.27.4, `./...` from the module root (nested modules excluded), `NeedTypes | NeedTypesInfo | NeedSyntax`, no tests, host build (darwin/arm64). 0 load errors on both repos. For every `CallExpr` in a top-level `FuncDecl` body (function literals inside included): the callee from `types.Info.Selections` (method value: interface or concrete, promoted when the selection path is longer than 1) or `types.Info.Uses` (function, builtin, conversion, func-typed variable). Callee key `pkgpath.Name` or `pkgpath.Recv.Name`; interface calls keyed by the receiver's named interface. Also computed: for every in-repo named interface, the in-repo named types whose value or pointer satisfies it (`types.Implements`).
- Syntax side (what M10 could ship): per-directory package index (funcs with result types, types with struct fields, embedded fields and interface methods, methods by receiver, package-level vars), imports mapped through `go.mod` (in-repo import paths to directories; the default import name read from the target's `package` clause, external ones guessed from the path), and a small local type inference: receiver, parameters, named results, `var x T`, `x := T{}`, `&T{}`, `new(T)`, `x := F()` / `x, err := pkg.F()` / `x := y.M()` with a declared result type, `x.(T)`, struct field chains through embedding, aliases. Scopes are flattened per top-level function (nearest preceding declaration of the name wins). Range variables, map and slice element types, and closures' captured variables are not inferred.
- Scoring: the truth is limited to files in the host build (caddy 211 of 230, hugo 508 of 519). Sites are paired by file, line and callee name (in order); every truth site found a syntax site. **In scope** = truth callee is a function or method declared in the repo. Recall = sites whose syntax callee equals the truth callee / in-scope sites. Precision = correct / sites where the syntax side emitted an in-repo callee. Edge figures dedupe to `(package dir, caller, callee)`, which is what the graph stores.
- Command: `pnpm tsx docs/spikes/v2-go/calls.ts <repo> <repo>-truth.json` (add `--samples` for the list of misses).

## Results

### In-repo call sites by kind

| Call kind (truth)                                     | caddy sites   | caddy recall       | hugo sites    | hugo recall          |
| ----------------------------------------------------- | ------------- | ------------------ | ------------- | -------------------- |
| Same package (`f()`)                                  | 1,020         | **100%**           | 1,505         | **99.9%**            |
| Package-qualified (`pkg.F()`)                         | 784           | **100%**           | 1,575         | **99.9%**            |
| Method on a concrete type (`x.M()`)                   | 3,620         | **95.6%**          | 5,258         | **93.0%**            |
| Method promoted through struct embedding              | 533           | 99.4%              | 360           | 94.4%                |
| Interface method (resolved to the interface's method) | 223           | 78.0%              | 2,011         | 79.2%                |
| **All in-repo sites**                                 | **6,180**     | **96.6%**          | **10,709**    | **92.4%**            |
| Precision (wrong callee emitted)                      | 5,967 emitted | **100%** (0 wrong) | 9,900 emitted | **99.99%** (1 wrong) |

Graph edges (deduplicated caller -> callee):

|                        | caddy            | hugo             |
| ---------------------- | ---------------- | ---------------- |
| Truth edges            | 3,742            | 8,577            |
| Syntax edges           | 3,585            | 7,994            |
| **Recall / precision** | **95.8% / 100%** | **93.2% / 100%** |

Why sites were missed (no callee emitted, never a wrong one):

| Reason                                                                                                               | caddy | hugo |
| -------------------------------------------------------------------------------------------------------------------- | ----- | ---- |
| Receiver type unknown (mostly range variables, map/slice index results, closure captures, results of external calls) | 189   | 712  |
| Type known, method not found (method of an embedded stdlib type or interface, e.g. `http.ResponseWriter.Header`)     | 20    | 94   |
| Other (local shadowing, external type)                                                                               | 4     | 3    |

Out of scope (no in-repo callee; the syntax side classifies these as external or builtin and emits no edge): caddy 10,938 of 17,118 sites (4,064 external package functions, 2,522 external methods, 853 external interface methods, 2,526 builtins, 547 conversions, 241 calls of func-typed values or fields, 185 other); hugo 14,808 of 25,517.

### Interface dispatch (what impact analysis would also want)

|                                                                           | caddy                  | hugo                      |
| ------------------------------------------------------------------------- | ---------------------- | ------------------------- |
| In-repo interface call sites                                              | 223                    | 2,011                     |
| Site x in-repo implementer pairs (truth, `types.Implements`)              | 4,662                  | 7,236                     |
| Interface sites with no in-repo implementer                               | 14                     | 106                       |
| In-repo (interface, implementer) pairs                                    | 582 over 65 interfaces | 2,029 over 310 interfaces |
| Satisfaction by **method names only** (no signatures), recall / precision | **98.6% / 85.3%**      | **79.2% / 82.4%**         |
| Interfaces skipped because they embed an interface outside the repo       | 6                      | 15                        |

### Cost

Index and resolve after parsing: 627 ms (caddy) and 1,166 ms (hugo), single-threaded, on top of 142 / 243 ms of parsing.

## Findings

1. **Function calls need no type checker.** Same-package and package-qualified calls resolve at 99.9 to 100% recall and 100% precision once imports map through `go.mod` and the default import name comes from the target package's `package` clause. The plan's "high confidence" label for these is right.
2. **Concrete method calls are the largest group and the plan does not mention them.** They are 59% (caddy) and 49% (hugo) of in-repo sites. Resolving them needs the local type inference described above (receiver, params, composite literals, constructor result types, field chains, embedding). With it, recall is 93 to 96% and precision 100%. Without it, only same-package and qualified calls resolve: about 29% of in-repo sites on both repos.
3. **Interface method calls resolve to the interface method at 78 to 79% recall with 100% precision.** The plan's "low confidence" fits the dispatch, not the resolution: `x.M()` on a value of interface type `I` reliably names `I.M`.
4. **Interface satisfaction can be approximated without type checking.** The plan says it is not computed. Matching method names alone finds 79 to 99% of the true (interface, implementer) pairs at 82 to 85% precision. Interface dispatch is where impact fan-out lives: caddy's 223 interface sites stand for 4,662 site-to-implementation pairs (the `caddy.Module`-style plugin interfaces). Impact analysis that stops at `I.M` misses every caller that reaches a concrete method through an interface. Name-based `implements` edges at low confidence would cover most of that.
5. **Misses are cheap to shrink.** Most of the remaining 3 to 8% are range variables and map/slice element types. Inferring element types for `[]T`, `map[K]T` and `range` would recover most of them. Embedded stdlib interfaces (`http.ResponseWriter`) need a small table of stdlib method sets, or stay unresolved.
6. **No false edges.** Every miss leaves the call unresolved, nothing guesses. One wrong callee in 15,867 emitted sites (hugo).
7. **Duplicate warnings do not depend on calls.** They use symbols and hashes (v2-go-parse: exact symbols). Call recall matters for impact analysis and the map. 93 to 96% direct-caller recall, with name-based interface dispatch, is in line with what the TypeScript side gets without a type checker (oxc spike: 77.8% of non-local call roots mapped).
8. **Build tags:** the truth covers the host build only. The syntax side reads all files, so it also sees calls in other-platform files (19 caddy files, 11 hugo files) that the truth cannot score. A helper binary would see only one platform unless it is run once per platform.

## Deviations and notes

- The truth limits calls to top-level function bodies, as the syntax side does; calls in package-level `var` initialisers are not scored on either side.
- Calls are paired by `file:line:name`, not byte column, because tree-sitter and `go/token` count columns differently. No truth site went unpaired.
- Interface keys: a direct interface call is keyed by the receiver's interface, and a call promoted through a struct embedding by the interface that declares the method, to match `go/types`. A first run keyed both by the declaring interface and showed 432 false "wrong callee" sites on hugo, a key-convention artefact that is fixed in the code.
- Two repos (230 and 519 source files). Both are module-heavy server code. A codebase that relies more on generics or dot imports could score lower; dot imports were absent from both.
- The helper-binary fallback was not built; the truth program is close to what it would be (about 370 lines over `go/packages`), and it took 2.1 to 2.3 s per repo including type-checking dependencies.

**Verdict: go-with-changes.** Syntax-only call edges are good enough for V2 Go: duplicate warnings do not need them, and impact analysis gets 93 to 96% of direct callers with no false edges. The helper binary is not needed for V2; keep it as a later option. Changes to the plan: (1) add concrete-method resolution with local type inference (receiver, params, literals, constructor result types, field chains, embedding, plus range and element types) as an explicit M10 requirement, since it is half of all in-repo calls; (2) label interface-method calls high confidence for the interface method, and add name-based interface satisfaction as low-confidence `implements` edges so impact analysis can fan out to implementations, instead of "not computed"; (3) map import names from the target package's `package` clause, not the path's last element; (4) add the per-kind recall above as conformance-suite thresholds for Go (same-package and qualified at least 99%, concrete methods at least 90%).

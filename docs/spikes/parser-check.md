# Spike: tags.scm queries or ast-grep node-kind tables for the basic language tier

Question: for the basic tier of languages (Java, Python, C#, Rust, Ruby), is it better to read symbols and call sites with tree-sitter directly, using each grammar's community `queries/tags.scm`, or with `@ast-grep/napi` and a node-kind table of our own? `@ast-grep/napi` stays for recipe rules either way. This report gives the numbers; it sets no bar.

## Setup

- Everything installs into a temporary directory (`$PARSER_CHECK_DIR`, default `<tmp>/parser-check`) with `pnpm tsx docs/spikes/parser-check/run.ts setup`. No `package.json` or lockfile of the repo changes. The measured repos are cloned there at the SHAs below; no third-party source is committed, only names, SHAs, file paths and counts.
- Packages (exact versions; the grammar packages ship the WASM build and `queries/tags.scm`; the `@ast-grep/lang-*` packages ship prebuilt parsers):

| Package                 | Version |
| ----------------------- | ------- |
| `web-tree-sitter`       | 0.27.2  |
| `tree-sitter-java`      | 0.23.5  |
| `tree-sitter-python`    | 0.25.0  |
| `tree-sitter-c-sharp`   | 0.24.0  |
| `tree-sitter-rust`      | 0.24.0  |
| `tree-sitter-ruby`      | 0.23.1  |
| `@ast-grep/napi`        | 0.51.3  |
| `@ast-grep/lang-java`   | 0.0.7   |
| `@ast-grep/lang-python` | 0.0.6   |
| `@ast-grep/lang-csharp` | 0.0.6   |
| `@ast-grep/lang-rust`   | 0.0.7   |
| `@ast-grep/lang-ruby`   | 0.0.7   |

- Repos (one small public repo per language; all tracked files with the language's extension, tests included):

| Language | Repo                  | Full SHA                                   | Files | Files of 30 to 250 lines |
| -------- | --------------------- | ------------------------------------------ | ----- | ------------------------ |
| Java     | google/gson           | `d9b5079eaa4567219771bba6d04289cf45c7589b` | 268   | 176                      |
| Python   | scrapy/scrapy         | `00acf3f31a322871a47aead5fec610d900263103` | 557   | 267                      |
| C#       | AutoMapper/AutoMapper | `79d10deec5881a617c38e7373f354694044bf83d` | 520   | 299                      |
| Rust     | clap-rs/clap          | `487474f013d3e0cbffc911934575f7ebcc72a6d4` | 337   | 143                      |
| Ruby     | rspec/rspec-core      | `aec5f49485d97908183dbe790a7fefb8baaa8091` | 233   | 130                      |

- Machine: Apple M3 Pro, 11 cores, 18 GB, darwin-arm64, Node v26.13.0. Load at the time of the timing runs (`uptime`): at start `8:00  up 2 days, 12:10, 2 users, load averages: 6.41 3.75 2.71`, at end `8:01  up 2 days, 12:10, 2 users, load averages: 5.67 3.79 2.76`. The machine was busy (other work running), so absolute times are pessimistic; the two parsers ran under the same conditions, one after the other, per language.

## Method

1. **Sample.** For each language, the eligible files are those with 30 to 250 lines (so a person can read every one). They are shuffled with a Fisher-Yates shuffle driven by `mulberry32(20240607)` and the first 15 are kept, sorted by path (`sample.json`). The rule and the seed were fixed before any file was listed.
2. **Rule-based count.** The 15 files per language were counted by one reader (an AI agent, no second reader) applying the rules below to a listing of each file with blank and comment-only lines removed. No tally notes were kept: the per-file numbers were written straight into a working file and then into `hand-counts.json` (numbers and paths only), so they cannot be shown to be independent of the tools beyond this statement. What can be said: the working file was complete for all 75 files before `score` or `bench` was first run, no tool output for the sampled files was viewed before that, and no count was edited afterwards (one column slip in three Rust rows was fixed before the first run). The file name keeps `hand-counts` for continuity. Counting rules, fixed before counting:
   - _function_: a named function not directly in a class, impl or module body (Python `def` outside a class body, Rust `fn` outside `impl` and `trait`, C# local functions, Ruby `def` with no enclosing `class` or `module`). _method_: a function directly in a class, interface, impl, trait or module body; constructors, destructors, operators and trait signatures count; lambdas, closures, property accessors and anonymous-class bodies do not (methods inside them count as methods of the class they are in).
   - _class_: class, struct, enum, record, union (Rust type aliases and `impl` blocks do not count). _interface_: Java and C# interface and annotation types, Rust traits. _module_: C# namespaces, Rust `mod` items (including `mod x;`), Ruby `module`; Java and Python have none.
   - _call_: a syntactic call: `f(x)`, `a.b(x)`, Rust `Some(x)`, Ruby `a.b` and `puts x` (a Ruby bare name with no receiver and no arguments is not a call). Not counted as calls: `new` (counted separately as _new_), Rust macro invocations (counted separately as _macro_), `nameof`/`typeof`, `this(...)`/`super(...)`, `yield`. Calls and macros inside the argument list of a macro (`assert_eq!(f(x), y)`) are counted separately (_inMacro_) because no tree-sitter query or table sees them; the sample holds 170 of them in Rust.
   - _import_: one per `import`, `from ... import`, `using` directive, `use` declaration, or Ruby `require`, `require_relative`, `load` call.
3. **ast-grep tables.** `tables.ts` holds one first-draft node-kind table per language (kinds for function, method, class, interface, module, import, call, object creation and macro, plus a rule that a function kind is a method when its nearest enclosing definition is a class-like kind). They were written from each grammar's `node-types.json` before any sample file was parsed and were not edited after the run. `engines.ts` holds the small shared interpreter (`findAll` on the union of kinds, then a parent walk for method versus function).
4. **tags.scm.** `engines.ts` runs the grammar's own `queries/tags.scm` through `web-tree-sitter` (`Query.matches`). Each match yields one tag, the capture named `definition.*` or `reference.*`. Buckets: definitions by capture name; `reference.call` and `reference.send` are calls, except on a `macro_invocation` node (macro); `reference.class` on an `object_creation_expression` node is a new; everything else is `other`. One normalisation, fixed before running: where one node is tagged both as method and as function (Rust tags every function in an `impl`, `trait` or `mod` body both ways) only the method is kept.
5. **Scoring.** Rule-based counts are per file and kind, so a match is by count, not by position: for each file and each kind, matched is the smaller of the rule-based count and the tool count. Recall is matched over the rule-based count, precision is matched over tool. A tool that finds as many of a kind as the rule-based count in a file, but different ones, scores full marks; the check is coarse by design, because the committed counts hold no source and no positions. "Strict" definitions use the five kinds as the brief names them. "Merged" counts function and method as one kind, which is the fair view for Python (its tags do not tell them apart). Because scoring is by count, a miss and an extra of the same kind in one file cancel out; this holds for both tools, so recall and precision can each be too high.
6. **Timing.** Per language and parser, three runs, each in a fresh process over every file of the repo (file reading excluded from the timer; one empty-file warm-up first). "Parse" is the parse call only; "parse + extract" adds the tags query or the table walk. The worst of the three is reported. Peak RSS is the worst of the three parse + extract runs (`process.resourceUsage().maxRSS`); the baseline is RSS after initialisation and warm-up, before any real file.

## Results against the rule-based count

Definition recall and precision are strict (five kinds). Counts in brackets are matched over the rule-based count (recall) and matched over tool (precision).

| Language | Parser         | Definition recall | Definition precision | Function+method merged: recall / precision | Call-site recall | Call-site precision | Other recall                  |
| -------- | -------------- | ----------------- | -------------------- | ------------------------------------------ | ---------------- | ------------------- | ----------------------------- |
| Java     | tags.scm       | 83.4% (126/151)   | 100.0% (126/126)     | 83.4% / 100.0%                             | 100.0% (368/368) | 100.0% (368/368)    | new 91.7%, imports 0.0%       |
| Java     | ast-grep table | 100.0% (151/151)  | 100.0% (151/151)     | 100.0% / 100.0%                            | 100.0% (368/368) | 100.0% (368/368)    | new 100.0%, imports 100.0%    |
| Python   | tags.scm       | 60.6% (80/132)    | 60.6% (80/132)       | 100.0% / 100.0%                            | 100.0% (368/368) | 100.0% (368/368)    | imports 0.0%                  |
| Python   | ast-grep table | 100.0% (132/132)  | 100.0% (132/132)     | 100.0% / 100.0%                            | 100.0% (368/368) | 100.0% (368/368)    | imports 100.0%                |
| C#       | tags.scm       | 88.1% (155/176)   | 100.0% (155/155)     | 88.1% / 100.0%                             | 59.0% (115/195)  | 100.0% (115/115)    | new 64.7%, imports 0.0%       |
| C#       | ast-grep table | 100.0% (176/176)  | 100.0% (176/176)     | 100.0% / 100.0%                            | 100.0% (195/195) | 99.0% (195/197)     | new 100.0%, imports 100.0%    |
| Rust     | tags.scm       | 88.2% (90/102)    | 84.1% (90/107)       | 100.0% / 95.3%                             | 77.5% (345/445)  | 100.0% (345/345)    | macros 96.6%, imports 0.0%    |
| Rust     | ast-grep table | 100.0% (102/102)  | 100.0% (102/102)     | 100.0% / 100.0%                            | 100.0% (445/445) | 100.0% (445/445)    | macros 100.0%, imports 100.0% |
| Ruby     | tags.scm       | 94.3% (116/123)   | 94.3% (116/123)      | 100.0% / 100.0%                            | 100.0% (946/946) | 32.6% (946/2898)    | imports 0.0%                  |
| Ruby     | ast-grep table | 100.0% (123/123)  | 100.0% (123/123)     | 100.0% / 100.0%                            | 100.0% (946/946) | 99.7% (946/949)     | imports 100.0%                |

Totals per kind over the 15 files (rule-based count, tags.scm, ast-grep table):

| Language | Kind      | Rule-based | tags.scm | ast-grep |
| -------- | --------- | ---------- | -------- | -------- |
| Java     | method    | 110        | 95       | 110      |
| Java     | class     | 40         | 30       | 40       |
| Java     | interface | 1          | 1        | 1        |
| Java     | call      | 368        | 368      | 368      |
| Java     | new       | 84         | 77       | 84       |
| Java     | import    | 115        | 0        | 115      |
| Python   | function  | 60         | 112      | 60       |
| Python   | method    | 52         | 0        | 52       |
| Python   | class     | 20         | 20       | 20       |
| Python   | call      | 368        | 368      | 368      |
| Python   | import    | 136        | 0        | 136      |
| C#       | function  | 3          | 0        | 3        |
| C#       | method    | 67         | 66       | 67       |
| C#       | class     | 87         | 85       | 87       |
| C#       | interface | 4          | 4        | 4        |
| C#       | module    | 15         | 0        | 15       |
| C#       | call      | 195        | 115      | 197      |
| C#       | new       | 51         | 33       | 51       |
| C#       | import    | 9          | 0        | 9        |
| Rust     | function  | 60         | 48       | 60       |
| Rust     | method    | 11         | 23       | 11       |
| Rust     | class     | 23         | 28       | 23       |
| Rust     | module    | 8          | 8        | 8        |
| Rust     | call      | 445        | 345      | 445      |
| Rust     | macro     | 116        | 112      | 116      |
| Rust     | import    | 31         | 0        | 31       |
| Ruby     | function  | 7          | 0        | 7        |
| Ruby     | method    | 73         | 80       | 73       |
| Ruby     | class     | 13         | 13       | 13       |
| Ruby     | module    | 30         | 30       | 30       |
| Ruby     | call      | 946        | 2898     | 949      |
| Ruby     | import    | 22         | 0        | 22       |

Reading the differences:

- **Java, tags.scm.** No constructors (`method_declaration` only), no records or enums (`class_declaration` only), no import capture. Calls are complete. Object creation is tagged only when the type is a plain identifier (generic types are missed).
- **Python, tags.scm.** One tag, `definition.function`, for every `def`; methods are not told apart from functions, so strict recall is 60.6% and merged recall 100%. A `definition.constant` for module-level assignments is extra. No imports.
- **C#, tags.scm.** No namespaces counted in the sample (the query needs a block namespace with a single-identifier name; the sample's namespaces are file-scoped or dotted), no local functions, no constructors, no structs, enums or records. Calls are tagged only when the callee is a member access (`a.B()`), so bare calls (`Call(...)`, `action()`) and generic method calls are missed: call recall 59.0%. No imports.
- **Rust, tags.scm.** Type aliases are tagged as classes, and every function in a `mod` body is tagged as a method because the query matches any `declaration_list`. Path calls (`Command::new(..)`, `Self::Foo(..)`) are missed: call recall 77.5%. No imports. Function/method mix-ups are removed by the merged column.
- **Ruby, tags.scm.** Calls are complete but every bare identifier and constant is also tagged as a call (2,898 tags for 946 calls), so call precision is 32.6%. This figure is unreliable: the query's `#is-not? local` predicate was not evaluated (it needs a locals pass), so it is the precision of the query run without that filter, not of the query as designed. Top-level `def` is a method here (merged column). No imports.
- **ast-grep tables.** Agreement is 100% on all definition kinds in all five languages. This shows the table agrees with counting rules written in the same syntactic way, not that either is accurate. Calls differ in three places: C# counts two `nameof(..)` expressions as calls (precision 99.0%) and Ruby counts three more `call` nodes than the rule-based count (precision 99.7%; one is `super(..)` with arguments, the other two were not diagnosed). The agreement is high partly by construction: the counting rules were written as syntactic rules, and a node-kind table reads the same syntax. It says the table is complete against those rules, not that the rules capture every meaning of "call" or "method".
- Neither parser resolves what a call targets, and neither sees calls inside Rust macro arguments.

## Costs

`tags.scm`, and what it lacks:

| Language | Non-blank, non-comment lines in tags.scm | Patterns | Tag captures present                                                                                                                                          | Lines of ast-grep table |
| -------- | ---------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Java     | 14                                       | 7        | definition.class, definition.interface, definition.method, reference.call, reference.class, reference.implementation                                          | 13                      |
| Python   | 11                                       | 4        | definition.class, definition.constant, definition.function, reference.call                                                                                    | 13                      |
| C#       | 12                                       | 12       | definition.class, definition.interface, definition.method, definition.module, reference.class, reference.interface, reference.send                            | 19                      |
| Rust     | 31                                       | 14       | definition.class, definition.function, definition.interface, definition.macro, definition.method, definition.module, reference.call, reference.implementation | 13                      |
| Ruby     | 50                                       | 7        | definition.class, definition.method, definition.module, reference.call                                                                                        | 13                      |

- Every grammar package has a `queries/tags.scm`; none has an import capture (`hasImportCapture` is false for all five), none tags constructors, and Python's does not separate functions from methods. Imports are the main thing missing.
- The ast-grep tables are 13 to 19 lines per language (lines of the table object in `tables.ts`, after formatting), plus 16 lines for the shared interpreter in `engines.ts`. Imports cost one kind per language (Ruby needs a method-name check).
- The tables were not changed after the run. They were written after reading the grammars' node types and after the rule-based count, and before any sample file was parsed.

Time and memory over the whole repo (three runs, worst; milliseconds; megabytes):

| Language | Parser             | Files | Parse (ms) | Parse + extract (ms) | RSS before work (MB) | Peak RSS (MB) | Peak RSS, trees never freed (MB) | Files with parse errors |
| -------- | ------------------ | ----- | ---------- | -------------------- | -------------------- | ------------- | -------------------------------- | ----------------------- |
| Java     | tree-sitter (WASM) | 268   | 203        | 289                  | 102                  | 119           | 150                              | 0                       |
| Java     | @ast-grep/napi     | 268   | 119        | 212                  | 74                   | 140           | n/a                              | 0                       |
| Python   | tree-sitter (WASM) | 557   | 443        | 574                  | 103                  | 130           | 222                              | 0                       |
| Python   | @ast-grep/napi     | 557   | 279        | 489                  | 74                   | 224           | n/a                              | 0                       |
| C#       | tree-sitter (WASM) | 520   | 398        | 475                  | 125                  | 203           | 270                              | 2                       |
| C#       | @ast-grep/napi     | 520   | 261        | 385                  | 74                   | 182           | n/a                              | 2                       |
| Rust     | tree-sitter (WASM) | 337   | 291        | 412                  | 106                  | 126           | 199                              | 13                      |
| Rust     | @ast-grep/napi     | 337   | 178        | 314                  | 73                   | 189           | n/a                              | 13                      |
| Ruby     | tree-sitter (WASM) | 233   | 164        | 255                  | 110                  | 162           | 195                              | 0                       |
| Ruby     | @ast-grep/napi     | 233   | 105        | 244                  | 74                   | 159           | n/a                              | 0                       |

- ast-grep takes 34% to 41% less time to parse than the WASM build in these runs and is faster end to end in every language; the gap narrows once the query or walk is included (Ruby: 244 ms against 255 ms).
- Peak RSS is mixed: the WASM runtime and a grammar cost 100 to 125 MB before the first file; the native module costs about 74 MB. During the run the native module peaked higher for Java, Python and Rust (nodes are garbage-collected, nothing is freed explicitly), up to 224 MB against 130 MB for Python, lower for C# and level for Ruby.
- **Freeing trees.** The WASM trees must be freed explicitly (`tree.delete()`); the numbers above do that. Without it the peak grows by 31 to 92 MB on these repos ("trees never freed" column) and keeps growing with the repo. `@ast-grep/napi` has nothing to free; its nodes are collected by the garbage collector.
- The parse-error files (C# 2, Rust 13) are the same files for both parsers.
- WASM build sizes: Java 0.4 MB, Python 0.5 MB, Rust 1.1 MB, Ruby 2.1 MB, C# 7.3 MB (plus the `web-tree-sitter` runtime). The `@ast-grep/lang-*` parsers are native prebuilds for macOS arm64 and x64, Linux arm64 and x64, and Windows x64; there is none for Windows arm64 (the same gap the Go grammar has).

## What each option cannot do

- **tags.scm with web-tree-sitter.** Cannot list imports. Cannot tell a method from a function in Python, and tags every function in a Rust `mod` as a method. Misses constructors in Java and C#, records and enums in Java, structs, enums and records in C#, local functions, path calls in Rust, bare calls in C#. Counts every bare name as a call in Ruby unless a locals pass is added. Needs a second runtime (`web-tree-sitter`) next to `@ast-grep/napi`, the WASM files of each grammar shipped or fetched, and explicit freeing of every tree. It does run on every platform Node runs on, including Windows arm64. A fix for any gap means editing the query, which is then a file of ours, about the size of a table.
- **ast-grep with our own tables.** Needs a table per language that we write and keep up to date with grammar changes (the grammar packages are at 0.0.x). Has no ready-made notion of "tag"; everything beyond kinds (method versus function, a constructor, an import call) is code we own, though 16 lines of it are shared. Has no prebuilt parser for Windows arm64 in these five packages, so the language would be skipped there. Sees no calls inside Rust macro arguments either.
- **Both.** Neither resolves names or call targets; counts are syntactic. Neither reads inside Rust macro arguments (170 calls and nested macros in the sample).

## Recommendation

The accuracy comparison is weak and should not decide this. The baseline is a rule-based count by one reader, written with syntactic rules that a node-kind table reads the same way, so the tables' 100% agreement shows consistency with those rules and nothing more; scoring is by count, so offsetting errors cancel for both tools; the sample is 15 small files per language from one repo each; the Ruby tags precision (32.6%) was measured without the query's `#is-not? local` predicate. Rust's strict definition gap is a naming difference (merged recall is 100%).

What the data does support is on the cost side. For `tags.scm`: no grammar has an import capture; C# misses bare calls (call recall 59.0%) and Rust misses path calls (77.5%); Java misses constructors, records and enums; Python cannot tell methods from functions; it needs a second runtime next to `@ast-grep/napi`, the WASM files of each grammar, and explicit freeing of every tree (31 to 92 MB more peak memory if skipped); it parses about 34% to 41% slower here (busy machine). For ast-grep tables: about 15 lines of table per language plus 16 shared lines that we write and maintain, and imports come at the cost of one kind per language; ast-grep is already approved and used for recipe rules; peak memory was higher for three of five languages; and the `@ast-grep/lang-*` parsers have no Windows arm64 build, where the WASM path would still run. On those points ast-grep tables look cheaper to extend (imports, constructors, struct-like types are edits to a short table), and `tags.scm` is the portable option. A reasonable reading is: tables for the basic tier if imports are wanted, `tags.scm` only if Windows arm64 coverage matters more than imports and the gaps above. The maintainer decides.

## Differences from the brief

- The baseline is a rule-based count by one reader with no kept tally notes (see Method), not an independent hand count. The committed `hand-counts.json` holds counts per file and kind, as the brief asks, so recall and precision are count-level agreement, not position-level.
- Sampling is from files of 30 to 250 lines, not from all files, so that a person can read 75 files. Two extra count fields (object creation, macros) and a Rust "inside macro arguments" field were added so the tools are not penalised for what no query can see.
- `tags.scm` exists for all five grammars; `web-tree-sitter` 0.27.2 loaded every WASM build and compiled every query (grammar ABI 14 or 15), so no language was recorded as failed.
- Two Ruby predicates (`#select-adjacent!`, `#is-not? local`) are passed to the engine but not acted on; the Ruby numbers are for the query as the engine evaluates it.
- Parse time is for the whole repo as asked, but the brief's "peak RSS" is a process-level high-water mark in a fresh process per run, which includes the runtime itself; the before-work column is given for subtraction.

## Reproduce

```
export PARSER_CHECK_DIR=/some/temp/dir
pnpm tsx docs/spikes/parser-check/run.ts setup
pnpm tsx docs/spikes/parser-check/run.ts sample        # rewrites sample.json (same seed, same files)
pnpm tsx docs/spikes/parser-check/run.ts score         # writes score.json
pnpm tsx docs/spikes/parser-check/run.ts bench         # writes bench.json
pnpm tsx docs/spikes/parser-check/run.ts table-lines   # writes table-lines.json
```

Files in `docs/spikes/parser-check/`: `run.ts` (commands), `langs.ts` (repos, pins, seed), `tables.ts` (the node-kind tables), `engines.ts` (the two extractors), `sample.json`, `hand-counts.json`, `score.json`, `bench.json`, `table-lines.json`.

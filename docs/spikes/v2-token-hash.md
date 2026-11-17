# Spike: shared hashing from a language-supplied token stream

V2 plan, M10 ("Hashing. `exactHash`, `shapeHash` and `minhash` are computed once, in shared code, from the normalised token stream the language supplies"). Questions: can today's hashes be driven from a token stream with TypeScript output byte-identical on `fixtures/pnpm-turbo`, and where does the line between language code and shared code have to fall?

## Setup

- Code base: `origin/main` at `5eee89d`. Today `packages/core/src/hash/index.ts` (one file, about 700 lines) produces **five** values per symbol, not the three the plan names: `exactHash`, `renamedHash` (#151), `shapeHash`, `minhash` (shape stream) and `nearMinhash` (exact stream with the symbol's own name as `$0`, the near tier's token gate, #131). `indexer.ts:368` is the only production caller of `hashSymbol`; `dup/engine.ts` reads all five.
- How the five are made today: one oxc AST walk (`Walker`) builds the exact stream (ESTree node types, flags, operators, literal values, locals renamed `$1…` via a scope model of JS/TS declarations, property names `P:x`, free identifiers `I:x`) and the shape stream (node types, `ID`/`STR`/`NUM`/`TPL` placeholders, `:op` suffixes). Everything after the streams (sha256 of the joined stream, 64-slot FNV/fmix MinHash over 5-shingles, the `$0` substitution) never looks at the AST.
- Prototype (`docs/spikes/v2-token-hash/`):
  - `shared-hash.ts`: the language-blind half. Input `TokenStreams { exact, shape, selfRefs }` where `selfRefs` are positions in `exact` that refer to the symbol's own name; output the five values. About 80 lines, a copy of today's output code with the `I:`-prefix check replaced by `selfRefs`, so it no longer knows TypeScript's token spelling.
  - `ts-normaliser.ts`: the TypeScript module's half: today's `Walker`, unchanged. To avoid committing a second copy, it loads a patched copy of the current `hash/index.ts` (internal `analyze` exported, imports made absolute) from a temp dir. It maps today's `rootNames` to `selfRefs`.
  - `generic.ts`: a language-blind shape normaliser over a tree-sitter tree (ast-grep's built-in TypeScript/TSX grammar), driven by a per-language kind table (identifier, string, number, template, comment kinds), to test the stronger reading of the plan: shared code also does the normalising.
  - `run.ts`: compares field by field against `hashSymbol`, against what `indexRepo` stored for `fixtures/pnpm-turbo`, and compares duplicate pairs between the oxc and the generic shape streams.
- Deps: `@ast-grep/napi` 0.51.3 in the spike folder's own `package.json` (`npm install` there), for part 2 only. Node v26.13.0, Apple M3 Pro. Command: `pnpm tsx docs/spikes/v2-token-hash/run.ts` (13 s wall, mostly the all-pairs comparison).

## Results

### Part 1: shared hashing fed by the TypeScript token stream

| Corpus                    | Symbols | exactHash   | renamedHash | shapeHash   | minhash     | nearMinhash |
| ------------------------- | ------- | ----------- | ----------- | ----------- | ----------- | ----------- |
| `fixtures/pnpm-turbo`     | 28      | 28/28       | 28/28       | 28/28       | 28/28       | 28/28       |
| `fixtures/adapters`       | 67      | 67/67       | 67/67       | 67/67       | 67/67       | 67/67       |
| `fixtures/single-pkg`     | 17      | 17/17       | 17/17       | 17/17       | 17/17       | 17/17       |
| `fixtures/nx`             | 3       | 3/3         | 3/3         | 3/3         | 3/3         | 3/3         |
| `packages/*` of this repo | 3,222   | 3,222/3,222 | 3,222/3,222 | 3,222/3,222 | 3,222/3,222 | 3,222/3,222 |

Store check: `fixtures/pnpm-turbo` indexed with the real `indexRepo` (main layer); **26/26 stored symbols** (`exact_hash`, `renamed_hash`, `shape_hash`, `minhash`, `near_minhash` blobs) are byte-identical to the split pipeline's output. (26, not 28: the indexer excludes `routeTree.gen.ts` and the nested worktree folder.) Since the hashes are the only symbol fields that pass through `hash/`, the graph for the fixture is byte-identical.

### Part 2: a shared, language-blind normaliser for TypeScript

| Metric (this repo's `packages/*`, 1,044 symbols with >= 6 statements) | oxc stream (today) | generic tree-sitter stream                                              |
| --------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------- |
| Streams identical to today's                                          | -                  | **0 of 1,044** (so every stored `shapeHash` and `minhash` would change) |
| Pairs with equal `shapeHash`                                          | 28                 | 28; all 28 the same pairs                                               |
| Pairs with shape MinHash Jaccard >= 0.85                              | 38                 | 41; all 38 found (recall 100%, precision 92.7%)                         |
| Fixture near-duplicate `formatRelativeDate` ~ `parseTimestamp`        | Jaccard 1.000      | 1.000                                                                   |

The generic normaliser only produces the shape stream. The exact and near streams need the scope model (which identifiers are locals, which are property names, which are the symbol itself) and it has no language-blind form: `Walker.enter` and `isPropertyName` are JS/TS rules.

## Findings

1. **Byte-identical is achievable, and only one way round.** If each language supplies its streams and shared code does the rest, TypeScript output stays byte-identical (3,337 symbols over all fixtures and this repo, plus the fixture's store). The shared part is small (sha256, MinHash, `$0` substitution); the language part is the large one (the walk, scope tracking, literal and template handling, the fallback for unparseable slices).
2. **"Computed once, in shared code, from the normalised token stream" must mean the hashing, not the normalising.** A shared normaliser over tree-sitter kinds changes every TypeScript hash (0 of 1,044 identical streams) because the token vocabulary is oxc's ESTree names, so it fails the plan's own byte-identical rule. It does keep the duplicate structure (same equal-shape pairs, all near pairs plus 3 extra), so for a new language such a table-driven shape normaliser is a reasonable starting point; the exact and near streams still need a per-language scope model.
3. **The plan's interface undercounts the outputs.** There are five hash outputs and the near tier depends on a third stream (exact with self-references as `$0`). The language contract needs `selfRefs` (or an equivalent marker), not just "identifiers, literals and types reduced to placeholders". The exact stream keeps literal values and property names on purpose (the near tier's token gate relies on them), so "literals reduced to placeholders" is true only of the shape stream.
4. **The embedding normaliser (`normalizeForEmbedding`) is the same walk** (it reuses the walk's text edits). It is language-specific too and belongs in the language module; the plan's interface table does not list it.
5. **Thresholds.** Because the token vocabulary is per language, MinHash values are not comparable across languages; this agrees with the plan's "comparisons never cross languages" and "thresholds per language" (spec section 17 has one set today).
6. **The near-tier `stmtCount >= 6` and `stmtCount >= 3` gates** in `dup/engine.ts` are statement counts from the TypeScript parser; each language must supply a statement count too (Go: statements in the body).

## Deviations and notes

- The issue asked for a diff on `fixtures/pnpm-turbo`; the comparison also ran on the other fixtures and on this repo's own sources (public) to get past 28 symbols.
- No change to `packages/` was made; the TypeScript half is a runtime-patched copy of the current file, so the spike breaks loudly (`hash/index.ts no longer has analyze()`) if the file is restructured.
- Not checked: the runtime cost of the split (an extra array copy for `near` per symbol) and Go's statement counting.
- `pnpm biome check docs/spikes/v2-token-hash` passes. There are no tests and no `tsconfig.json` reference, so `tsc -b` and vitest do not see the folder.

**Verdict: go-with-changes.** Split hashing as "language supplies `{ exact, shape, selfRefs, stmtCount }`, shared code computes the five hashes"; TypeScript stays byte-identical. Changes to the plan: say the shared part is hashing only (normalising, scope, embedding text stay per language); list all five outputs and the `selfRefs` marker in the interface; add `normalizeForEmbedding` and statement counts to the language interface table; keep thresholds per language.

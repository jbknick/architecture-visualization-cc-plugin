# Labelled set (private)

Builds the 200-function labelled set used to measure Haiku description quality (spec section 13).
The set itself is private test-bed data: it lives only in the git-ignored `evals/private/labelled/`
(in a worktree `evals/private` may be a symlink to a stable directory outside the repo). Only the scripts
and this README are committed. Never commit, paste or screenshot the output.

## Regenerate

```sh
# 1. Sample 200 symbols (seed 42) and build fact sheets -> candidates.jsonl
DEVPRENTICE_PATH=/path/to/devprentice pnpm tsx evals/labelled/sample.ts
#    the repo is read-only, never written; also set LABELLED_SERVER_DIRS to its server-side
#    workspace dirs, comma-separated with trailing slashes (the real values are recorded in
#    evals/private/labelled/sample-meta.json, not here)

# 2. Draft labels (a model, then the operator) as evals/private/labelled/draft-labels-*.json:
#    arrays of [candidateIndex, behavior (<= 25 words), nameFits, suggestedName?]

# 3. Merge -> devprentice.jsonl and review.md (scan table for the operator)
pnpm tsx evals/labelled/merge.ts

# 4. Validate
pnpm tsx evals/labelled/check.ts      # prints "200 valid"
```

Env: `DEVPRENTICE_PATH` (or first argument) selects the repo; `LABELLED_OUT` overrides the output directory.

## Sampling rules

Strata: 40 components, 30 hooks, 50 exported utils, 40 server-side (the workspace dirs named in
`LABELLED_SERVER_DIRS`: exported functions and handler-style `const x = call(fn)` bindings),
40 local (non-exported) helpers. Fixed PRNG seed 42 (mulberry32 Fisher-Yates over a path-sorted pool), at most
3 per file. Trivial single-statement functions are skipped (hooks are the scarce stratum, so short hooks with
one statement are skipped only when under 8 lines). Excluded: build output, tests, stories, `.d.ts`, `*.gen.ts`
and the sensitive names from spec section 5. Fact sheets follow spec section 7 (body trimmed to 1,500 chars,
callees are called identifiers, doc is the leading JSDoc).

## Human gate

`review.md` is reviewed and corrected by the operator before the issue closes; corrections are applied to
`devprentice.jsonl`.

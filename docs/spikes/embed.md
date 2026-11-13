# Spike #4: local embedding bake-off and sqlite-vec

Status: done on macOS arm64. Linux x64 not run (see "Platform status").

## Decision

| Use                               | Model                                                                     | Dimension D |
| --------------------------------- | ------------------------------------------------------------------------- | ----------- |
| Descriptions (`vec_descriptions`) | `jinaai/jina-embeddings-v2-base-code` (q8 ONNX, mean pooling, normalized) | 768         |
| Normalized code (`vec_code`)      | `jinaai/jina-embeddings-v2-base-code` (same model)                        | 768         |

One model serves both tables, so a single load and a single D = 768 for `vec0(content_key TEXT PRIMARY KEY, embedding float[768])`.

Why Jina: it had the best same/different separation on descriptions (90.0% best-threshold accuracy, next best 76.7%) and the best on normalized code (96.7% with the recommended normalizer, tied at 93.3% with MiniLM and nomic under the strict normalizer). The cost is speed and size: about 29 ms per code embedding at batch 32 (MiniLM: 3.7 ms), 163 MB on disk (MiniLM: 23 MB). That is acceptable for an index built once and updated incrementally; revisit if M2 cold-index time is a problem.

Recommended thresholds (differ from the spec defaults in section 17):

| Tier                            | Spec default | Recommended                          | Measured on this set                                                                                  |
| ------------------------------- | ------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `code_vector` (normalized code) | 0.92         | 0.96 (0.97 for zero false positives) | 0.96: recall 93%, false positives 7% (1 of 15). 0.97: recall 87%, 0% FP. At 0.92: recall 93%, FP 33%. |
| `semantic` (descriptions)       | 0.85         | 0.60 (0.55 if recall matters more)   | 0.60: recall 80%, FP 7%. 0.55: recall 87%, FP 13%. At 0.85: recall 0%, FP 0%.                         |

Both the spec defaults are wrong for this model on this data: 0.92 lets in a third of the different-logic pairs, and 0.85 matches no paraphrase pair at all. The semantic recommendation in particular was calibrated on hand-written paraphrases, not on the LLM-generated descriptions the product will store. Treat 0.60 as a starting point and re-fit it in M2 against real descriptions using `pairs.jsonl` plus the real set. The `semantic` tier also requires a compatible signature, which should cut false positives further.

## Method

Everything is in `docs/spikes/embed/`:

- `pairs.jsonl`: 60 hand-written pairs. 30 descriptions (15 same meaning, 15 different) and 30 TypeScript functions (15 same logic with different names, 15 different logic). Topics are common utilities (debounce, slugify, formatDate, chunk, retry with backoff, groupBy, pick, and so on). The different pairs are mostly hard negatives with the same shape (sum vs product, min vs max, capitalize vs lower-case, pick vs omit, debounce vs throttle). M2 can reuse the file as a regression set.
- `lib.ts`: cosine, threshold search, and the normalizer (tested in `embed.test.ts`).
- `run.ts`: the bake-off. `pnpm tsx docs/spikes/embed/run.ts` prints the tables below; `--detail` adds threshold sweeps and per-pair scores; `--json <file>` writes the numbers (`results.json` holds a `--detail` run).
- `vec.ts`: the sqlite-vec check. `pnpm tsx docs/spikes/embed/vec.ts [dim] [rows]`.

Setup: `@huggingface/transformers` 4.3.2, `dtype: "q8"`, `env.cacheDir = ~/.gantry/models`, mean pooling and L2 normalization, Node v26.13.0, macOS 27.2 on an Apple M3 Pro (arm64). Prefixes: none for MiniLM, bge and Jina; `search_document: ` on both sides for nomic, because both texts of a pair are stored documents. The nomic card also lists a `clustering:` prefix for similarity tasks, which was not tried and might change its numbers.

Normalizer (`normalizeCode`): identifiers that are not keywords become `v1, v2, ...` in order of first appearance, string and template literals become `"s"`, comments are dropped, whitespace collapsed, regex literals kept. Two variants were measured:

- strict: every non-keyword identifier is renamed, as the issue specifies. This includes member names (`.toUpperCase`) and built-ins (`Math`, `Promise`).
- keep members+globals: same, but names after `.` and a short list of built-ins are left as written.

All four candidates loaded; none had to be skipped.

## Results

Speed, dimension and load. ms/emb is the mean over 5 batches of 32 after one warm-up. Cold load is from the first run, which downloaded the model; warm load is from the disk cache (second run). The cold times depend on the network and the Hugging Face CDN and say little about the models; the Jina figure in particular looks low for a 163 MB download and may have been served from a fast cache.

| model                               | D   | disk   | cold load incl. download (s) | warm load (s) | ms/emb descriptions (b32) | ms/emb code (b32) |
| ----------------------------------- | --- | ------ | ---------------------------- | ------------- | ------------------------- | ----------------- |
| Xenova/all-MiniLM-L6-v2             | 384 | 23 MB  | 11.0                         | 0.04          | 0.80                      | 3.70              |
| Xenova/bge-small-en-v1.5            | 384 | 34 MB  | 15.7                         | 0.06          | 1.30                      | 7.30              |
| nomic-ai/nomic-embed-text-v1.5      | 768 | 145 MB | 65.7                         | 0.13          | 6.03                      | 29.49             |
| jinaai/jina-embeddings-v2-base-code | 768 | 163 MB | 3.7                          | 0.21          | 5.66                      | 29.33             |

Separation. "best threshold" is the cosine cutoff that maximizes accuracy on the 30 pairs of that task (midpoint of the best range); "at spec" is the accuracy at the spec default (0.85 for descriptions, 0.92 for code).

Descriptions:

| model         | mean cos same | mean cos diff | min same | max diff | best threshold | best accuracy | at spec 0.85 |
| ------------- | ------------- | ------------- | -------- | -------- | -------------- | ------------- | ------------ |
| MiniLM        | 0.583         | 0.398         | 0.371    | 0.788    | 0.454          | 76.7%         | 50.0%        |
| bge-small     | 0.748         | 0.659         | 0.605    | 0.828    | 0.660          | 73.3%         | 50.0%        |
| nomic         | 0.786         | 0.756         | 0.714    | 0.899    | 0.712          | 66.7%         | 46.7%        |
| **jina-code** | 0.641         | 0.351         | 0.352    | 0.730    | 0.573          | **90.0%**     | 50.0%        |

Raw code (no normalization):

| model     | mean cos same | mean cos diff | best threshold | best accuracy | at spec 0.92 |
| --------- | ------------- | ------------- | -------------- | ------------- | ------------ |
| MiniLM    | 0.714         | 0.637         | 0.596          | 66.7%         | 50.0%        |
| bge-small | 0.749         | 0.754         | 0.664          | 63.3%         | 46.7%        |
| nomic     | 0.817         | 0.829         | 0.772          | 60.0%         | 46.7%        |
| jina-code | 0.684         | 0.543         | 0.554          | 73.3%         | 50.0%        |

Normalized code, strict:

| model     | mean cos same | mean cos diff | min same | max diff | best threshold | best accuracy | at spec 0.92 |
| --------- | ------------- | ------------- | -------- | -------- | -------------- | ------------- | ------------ |
| MiniLM    | 0.991         | 0.852         | 0.881    | 1.000    | 0.979          | 93.3%         | 73.3%        |
| bge-small | 0.990         | 0.919         | 0.860    | 1.000    | 0.995          | 90.0%         | 66.7%        |
| nomic     | 0.994         | 0.933         | 0.925    | 1.000    | 0.980          | 93.3%         | 70.0%        |
| jina-code | 0.983         | 0.817         | 0.762    | 1.000    | 0.971          | 93.3%         | 80.0%        |

Normalized code, keeping members and globals:

| model         | mean cos same | mean cos diff | min same | max diff | best threshold | best accuracy | at spec 0.92 |
| ------------- | ------------- | ------------- | -------- | -------- | -------------- | ------------- | ------------ |
| MiniLM        | 0.986         | 0.811         | 0.865    | 0.980    | 0.961          | 93.3%         | 80.0%        |
| bge-small     | 0.988         | 0.891         | 0.882    | 0.996    | 0.996          | 86.7%         | 70.0%        |
| nomic         | 0.989         | 0.916         | 0.922    | 0.979    | 0.980          | 90.0%         | 76.7%        |
| **jina-code** | 0.985         | 0.765         | 0.829    | 0.965    | 0.967          | **96.7%**     | 80.0%        |

Threshold sweep for Jina (recall = same pairs at or above the threshold, FP = different pairs at or above it):

| threshold | descriptions recall / FP | code (keep members+globals) recall / FP |
| --------- | ------------------------ | --------------------------------------- |
| 0.50      | 93% / 20%                | 100% / 87%                              |
| 0.55      | 87% / 13%                | 100% / 80%                              |
| 0.60      | 80% / 7%                 | 100% / 73%                              |
| 0.70      | 20% / 7%                 | 100% / 73%                              |
| 0.80      | 7% / 0%                  | 100% / 47%                              |
| 0.85      | 0% / 0%                  | 93% / 40%                               |
| 0.92      | 0% / 0%                  | 93% / 33%                               |
| 0.95      | 0% / 0%                  | 93% / 7%                                |
| 0.96      | 0% / 0%                  | 93% / 7%                                |
| 0.97      | 0% / 0%                  | 87% / 0%                                |
| 0.99      | 0% / 0%                  | 73% / 0%                                |

## Findings

1. Normalization is what makes code vectors work. Raw code scores 60 to 73% for every model (near chance for the three non-code models); after normalization every model reaches 87 to 97%. The `code_vector` tier is only meaningful on normalized text.
2. The strict normalizer erases information. Because `.toUpperCase` and `.toLowerCase` both become `.v3`, `capitalize` vs `decapitalize` normalizes to identical text and scores 1.000 for every model (that is the 1.000 "max diff" in the strict table). Keeping member names and built-ins fixes that pair (Jina 0.928) and raised Jina's best accuracy from 93.3% to 96.7%. Recommendation for the M2 normalizer: rename local identifiers (parameters, `const`/`let` names, function name) but keep property names and well-known globals. This departs from the issue's wording, which says to rename identifiers in order of appearance without that carve-out; the spike implements both and reports both.
3. Pairs that remain hard even for the best setup: `min-vs-max` (0.965) and `sum-vs-product` (0.926), where the code differs by one operator or one literal. Embeddings of this size cannot separate those; the `near` tier (`shapeHash`/MinHash) and the final reuse-guard review have to carry them. On the same-logic side, `unique` vs `dedupe` scored lowest (0.829); no cause was investigated.
4. Description separation is weak for every model, and the spec's 0.85 threshold is far above what paraphrases reach (best same pair 0.801 for Jina, 0.807 for MiniLM). Jina's mean same/different gap (0.641 vs 0.351) is much wider than the others (nomic: 0.786 vs 0.756, nearly compressed to nothing).
5. The set is small: 15 + 15 pairs per task, so each pair is 3.3 percentage points of accuracy and the thresholds above are indicative only. The pairs were written by hand by one author and the "different" pairs lean toward hard negatives, so false-positive rates are probably pessimistic compared with comparing random pairs of functions.

## sqlite-vec

Version that works: `sqlite-vec@0.1.9`, pinned exactly (`"sqlite-vec": "0.1.9"`, no caret) in `packages/core/package.json`. It is a dependency of `@gantry/core` with `better-sqlite3` 13.1.1.

Loading:

```ts
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const db = new Database(path);
sqliteVec.load(db); // finds the prebuilt extension from the platform optionalDependency
db.exec("CREATE VIRTUAL TABLE vec_code USING vec0(content_key TEXT PRIMARY KEY, embedding float[768])");
db.prepare("INSERT INTO vec_code (content_key, embedding) VALUES (?, ?)").run(
  key,
  Buffer.from(float32.buffer),
);
db.prepare(
  "SELECT content_key, distance FROM vec_code WHERE embedding MATCH ? AND k = 10 ORDER BY distance",
).all(buf);
```

KNN top-10 over 10,000 random unit vectors, 50 queries, Apple M3 Pro, Node v26.13.0 (`pnpm tsx docs/spikes/embed/vec.ts 768`; `vec_version()` reports v0.1.9):

| D            | insert 10k (one transaction) | KNN mean | p50     | p95     | max     |
| ------------ | ---------------------------- | -------- | ------- | ------- | ------- |
| 768 (chosen) | 174 ms                       | 1.48 ms  | 1.42 ms | 1.81 ms | 2.14 ms |
| 384          | 104 ms                       | 0.78 ms  | 0.77 ms | 0.93 ms | 0.94 ms |

Target is under 50 ms: passed by more than 20x. Only 10,000 rows were measured; larger tables were not tested.

Notes for the production embed module:

- `vec0` with a `TEXT PRIMARY KEY` works; vectors are passed as `Buffer.from(Float32Array.buffer)`.
- Because the model cosine-normalizes output, L2 distance from `vec0` converts to cosine as `cos = 1 - d^2 / 2`. The spike scripts compute cosine directly and did not exercise this conversion.
- Spec section 9 says the tables are created after D is known (migration v2). D = 768 if this decision is accepted.

## Platform status

| platform                                  | sqlite-vec via better-sqlite3                                                  | embedding models        | status                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------ | ----------------------- | ------------------------------------------------- |
| macOS arm64 (Apple M3 Pro, Node v26.13.0) | works, numbers above                                                           | all four loaded and ran | measured                                          |
| Linux x64                                 | `sqlite-vec-linux-x64@0.1.9` is in the lockfile as a prebuilt optional package | not run                 | pending operator (no Linux machine was available) |

To close the Linux row, run on a Linux x64 host: `pnpm install && pnpm tsx docs/spikes/embed/vec.ts 768` (expect `sqlite-vec v0.1.9 loaded` and the KNN line). The embedding run (`run.ts`) is only needed there if latency on Linux matters.

## Notes

- Model licenses from the Hugging Face API: all-MiniLM-L6-v2, nomic-embed-text-v1.5 and jina-embeddings-v2-base-code are Apache-2.0. The API reported no license for the bge-small-en-v1.5 Xenova mirror.
- Disk use under `~/.gantry/models/` is about 365 MB for the four candidates; the chosen model alone is 163 MB.
- Dependencies added: `sqlite-vec` (exact) and `@huggingface/transformers` to `packages/core`, both listed in spec section 2. `tsx` (spec dev dependency) plus `sqlite-vec`, `better-sqlite3` and `@huggingface/transformers` to the root `devDependencies`, so the scripts under `docs/` resolve them; the root copies can go when the production embed module lands.

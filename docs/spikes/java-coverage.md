# Java call coverage: a sanity count

How many method-invocation sites of a real Java repo get a `calls` edge from the Java pack. This is a count, not a
proof: it says nothing about whether an edge is right, and it has no bar.

## What is counted

`docs/spikes/java-coverage/count.ts` clones gson (`https://github.com/google/gson.git`) at commit
`686fad782d969d8f15c7581a5435a208b810caa7` (tag `gson-parent-2.13.2`) into a temp directory, indexes it and prints the
numbers below for main code: the 119 `.java` files under a `src/main/` folder. No third-party source is committed.

- `sites`: `method_invocation` nodes (constructor calls are not sites).
- `sitesWithEdge`: sites whose `path:line` is evidence of a `calls` edge from that file. It is by line, so two calls on
  one line count together, and an edge keeps at most 20 evidence lines, so it is low by at most `capped`.
- `high`, `low`: `calls` edges whose source is in main code, by confidence.
- `calls`: the sum of the `count` of those edges (constructor calls included).

Run it from the repo root with `pnpm exec tsx docs/spikes/java-coverage/count.ts`; `--core <checkout>` counts with
the indexer of another checkout of this repo, and `--lines <file>` writes the `path:line` of every site with an edge,
sorted, so two runs can be compared.

## Numbers

|                                                 | sites | sitesWithEdge | share | high | low | calls | capped |
| ----------------------------------------------- | ----- | ------------- | ----- | ---- | --- | ----- | ------ |
| before (the Java pack as first merged)          | 3053  | 1595          | 52.2% | 1226 | 621 | 2160  | 4      |
| after (type arguments, callers outside methods) | 3053  | 1860          | 60.9% | 1413 | 853 | 2683  | 11     |

The share of main-code sites with an edge rose by 8.7 points (265 sites). Compared by line (`--lines`), no site that
had an edge before is without one after. The sites without an edge were not
sorted by cause here; calls of JDK and library methods have no symbol to point at, and lambda parameters and method
references make no edge.

# Changelog

One section per release, newest first. Written by `pnpm release`.

## 0.2.0 - 2026-11-24

- Language packs. One engine reads a pack per language, and Go now comes from a pack. New packs: Java (Maven and Gradle), Python, C# and Rust, each parsed with a tree-sitter grammar and no compiler, interpreter or build tool installed. Each pack makes symbols, imports, workspaces from its manifests and call edges.
- Call levels. Every call edge of a pack says which resolver made it. Go, Java, C# and Rust call edges are level 2, read from declared types: no edge where a type is not known. C# and Rust edges are all high confidence and sparse. Python adds level 3, the flow resolver, which reads the values assigned in the code where no type is declared; every level 3 edge is low confidence.
- Packs measured against SCIP truth on two public repos each, in `docs/packs-proof.md`. Java misses its bar: mybatis-3 meets every bar, jackson-databind call recall is 83.79% against 85%, and high-confidence precision is above 99% on both. Python misses its bar: both precision bars are met on django and prefect, call recall is 65.02% and 66.60% against 70%, and symbol recall is below 97% because definitions nested in function bodies are not symbols. Go, C# and Rust are not measured.
- Precise mode, opt-in: `gantry index --scip <file>` or `precise.scip` in the config reads a SCIP index you made with your own indexer and takes the call, render, hook and type edges of the files it covers from it. Gantry never runs an indexer.
- Also since 0.1.0: workspaces of several repos (repo groups on the project map, calls linked across repos, search and duplicates across repos), the reachable tier of the blast radius, a curation overlay (rename, hide and group, saved views), and recipes for routes, endpoints and tables in any ORM.

## 0.1.0 - 2026-11-16

- First versioned release. The version now lives in the root `package.json` and is kept equal in `plugin/.claude-plugin/plugin.json` and the workspace packages, so `claude plugin update` picks up new builds (#187).

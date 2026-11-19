import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type GantryConfig,
  hashSymbol,
  loadConfigForDb,
  openStore,
  parseSource,
  type Store,
  type SymbolRecord,
} from "@gantry/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DupFinding,
  diskCheck,
  formatCapped,
  formatFinding,
  formatLines,
  type ImportLine,
} from "./findings.js";

const dup = (i: number): DupFinding => ({
  kind: "duplicate",
  symbolId: `sym:repo:apps/web/src/lib/new.ts#newFn${i}`,
  existingId: "sym:repo:packages/utils/src/slug.ts#slugify",
  name: `newFn${i}`,
  path: "apps/web/src/lib/new.ts",
  line: i,
  existing: "slugify",
  existingPath: "packages/utils/src/slug.ts",
  existingLine: 3,
  tier: "near",
  score: 0.9123,
  action: "Import it: import { slugify } from '@acme/utils'",
  inline: true,
});
const imp: ImportLine = {
  kind: "import",
  line: 4,
  action: 'Declare "@acme/db" in apps/web/package.json',
  pkg: "@acme/db",
  manifests: ["apps/web/package.json", "package.json"],
};

describe("findings formatter", () => {
  it("formats duplicates and imports as the spec lines", () => {
    expect(formatFinding(dup(7))).toBe(
      "Gantry: newFn7 (apps/web/src/lib/new.ts:7) looks like slugify in packages/utils/src/slug.ts:3 [near 0.91]. Import it: import { slugify } from '@acme/utils'",
    );
    expect(formatFinding(imp)).toBe('Gantry: Declare "@acme/db" in apps/web/package.json (line 4)');
  });

  it("caps the PostToolUse text at 600 chars and keeps whole lines", () => {
    const text = formatCapped([dup(1), dup(2), dup(3), dup(4), dup(5), imp]);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text.split("\n").every((l) => l.startsWith("Gantry: "))).toBe(true);
    expect(text.split("\n").length).toBeLessThan(6);
    expect(formatCapped([])).toBe("");
  });

  it("cuts a single over-long line instead of printing nothing", () => {
    const text = formatCapped([{ ...dup(1), action: "x".repeat(900) }]);
    expect(text).toHaveLength(600);
    expect(text.endsWith("…")).toBe(true);
  });

  it("pre-commit lines have no character cap but at most 10 lines", () => {
    expect(formatLines(Array.from({ length: 14 }, (_, i) => dup(i)))).toHaveLength(10);
  });
});

describe("diskCheck: the exact tier on a renamed copy (#151)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  const fn = (name: string, extra = "const scaled = capped * 2;"): string =>
    `export function ${name}(value: number, lo: number, hi: number): number {
  const floor = Math.max(value, lo);
  const capped = Math.min(floor, hi);
  ${extra}
  return scaled;
}
`;

  /** Stores `source` as the main-layer file `rel` (symbol `name`) and returns its record. */
  function put(
    store: Store,
    rel: string,
    name: string,
    source: string,
    opts: { renamed?: boolean; noShape?: boolean } = {},
  ): SymbolRecord {
    const parsed = parseSource("repo", rel, source);
    const sym = parsed.symbols.find((x) => x.name === name);
    const range = sym && parsed.bodies.get(sym.id);
    if (!sym || !range) throw new Error("no symbol");
    const h = hashSymbol(source, range, rel);
    const fileId = `file:repo:${rel}`;
    const rec: SymbolRecord = {
      ...sym,
      lang: "typescript",
      fileId,
      exactHash: h.exactHash,
      ...(opts.renamed === false ? {} : { renamedHash: h.renamedHash }),
      // noShape: shape fields that match nothing, so only the renamedHash shortcut can keep a finding.
      shapeHash: opts.noShape ? "none" : h.shapeHash,
      minhash: opts.noShape ? new Uint32Array(64) : h.minhash,
      nearMinhash: h.nearMinhash,
    };
    store.setMeta("repo", "repo");
    store.replaceFile(
      "main",
      {
        id: fileId,
        path: rel,
        lang: "typescript",
        workspaceId: null,
        contentHash: rel,
        mtimeMs: 0,
        deleted: false,
      },
      [rec],
      [],
    );
    return rec;
  }

  function setup(): { root: string; store: Store; config: GantryConfig } {
    const root = mkdtempSync(join(tmpdir(), "gantry-diskcheck-"));
    const dbPath = join(root, ".data", "gantry.db");
    const store = openStore(dbPath);
    cleanups.push(() => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    return { root, store, config: loadConfigForDb(dbPath, { HOME: root }) };
  }

  const write = (root: string, rel: string, source: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), source);
  };

  const finding = (mine: SymbolRecord, existing: SymbolRecord, tier: string): DupFinding => ({
    ...dup(1),
    symbolId: mine.id,
    existingId: existing.id,
    name: mine.name,
    path: "src/new.ts",
    existing: existing.name,
    existingPath: "src/old.ts",
    tier,
  });

  it("keeps an exact finding when the matched file now holds a renamed copy (a fresh renamedHash)", () => {
    const { root, store, config } = setup();
    const mine = put(store, "src/new.ts", "limitTwice", fn("limitTwice"), { noShape: true });
    // Stored at an older version of the body, so neither the stored nor the new exactHash equals the fresh one.
    const old = put(store, "src/old.ts", "clampDouble", fn("clampDouble", "const scaled = capped * 3;"));
    write(root, "src/old.ts", fn("clampDouble"));
    expect(old.exactHash).not.toBe(mine.exactHash);
    const keep = diskCheck(root, store, config);
    expect(keep(finding(mine, old, "exact"))).toBe(true);
    // Only the exact tier takes the shortcut.
    expect(keep(finding(mine, old, "near"))).toBe(false);
  });

  it("keeps an exact finding when the stored row is unchanged on disk", () => {
    const { root, store, config } = setup();
    const mine = put(store, "src/new.ts", "limitTwice", fn("limitTwice"));
    const old = put(store, "src/old.ts", "clampDouble", fn("clampDouble"));
    write(root, "src/old.ts", fn("clampDouble"));
    expect(diskCheck(root, store, config)(finding(mine, old, "exact"))).toBe(true);
  });

  it("drops an exact finding when the matched function changed to something else", () => {
    const { root, store, config } = setup();
    const mine = put(store, "src/new.ts", "limitTwice", fn("limitTwice"));
    const old = put(store, "src/old.ts", "clampDouble", fn("clampDouble"));
    write(
      root,
      "src/old.ts",
      `export function clampDouble(a: string): string {
  return a.trim();
}
`,
    );
    expect(diskCheck(root, store, config)(finding(mine, old, "exact"))).toBe(false);
  });

  it("does not use renamedHash for a code_vector finding whose match changed", () => {
    const { root, store, config } = setup();
    const mine = put(store, "src/new.ts", "limitTwice", fn("limitTwice"));
    const old = put(store, "src/old.ts", "clampDouble", fn("clampDouble", "const scaled = capped * 3;"));
    write(root, "src/old.ts", fn("clampDouble"));
    expect(diskCheck(root, store, config)(finding(mine, old, "code_vector"))).toBe(false);
  });
});

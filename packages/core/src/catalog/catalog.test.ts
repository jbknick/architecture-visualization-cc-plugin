import { existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncBacklog } from "../describe/backlog.js";
import { contentKey } from "../describe/factsheet.js";
import { cleanupData, type Indexed, indexedFixture } from "../describe/testkit.js";
import {
  BrowseTargetError,
  browse,
  CATALOG_DEBOUNCE_MS,
  CATALOG_NOTE,
  writeCatalog,
  writeCatalogDebounced,
} from "./index.js";

let ix: Indexed;
beforeEach(async () => {
  ix = await indexedFixture();
  syncBacklog(ix.store);
});
afterEach(async () => {
  await ix.close();
  cleanupData();
});

const read = (rel: string): string => readFileSync(join(ix.paths.catalogDir, rel), "utf8");
const files = (dir: string, base = dir): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name), base) : [join(dir, e.name).slice(base.length + 1)],
    )
    .sort();

function setDescription(id: string, behavior: string): void {
  const sym = ix.store.getSymbol(id);
  if (!sym) throw new Error(`no symbol ${id}`);
  ix.store.db
    .prepare(
      `INSERT OR REPLACE INTO descriptions(content_key, behavior, search_terms, name_fits, suggested_name,
         provenance, model, prompt_version, created_at) VALUES (?, ?, '[]', 1, NULL, 'model', 'haiku', 'p1', 'now')`,
    )
    .run(contentKey(sym.exactHash), behavior);
}

describe("writeCatalog", () => {
  it("writes one file per directory plus INDEX.md, only under the data dir, each starting with the note", () => {
    const n = writeCatalog(ix.store, ix.paths);
    const written = files(ix.paths.catalogDir);
    expect(n).toBe(written.length);
    expect(written).toContain("INDEX.md");
    expect(written).toContain("packages/utils/src.md");
    expect(ix.paths.catalogDir.startsWith(ix.paths.dataDir)).toBe(true);
    expect(existsSync(join(ix.fx.dir, "catalog"))).toBe(false);
    for (const f of written) expect(read(f).split("\n")[0]).toBe(CATALOG_NOTE);
    const src = read("packages/utils/src.md");
    expect(src).toMatch(/^- formatRelativeDate\(date: Date.* — .* \[packages\/utils\/src\/date\.ts:\d+\]$/m);
    expect(read("INDEX.md")).toMatch(
      /^- ws:@acme\/utils \(@acme\/utils\) — packages\/utils: \d+ functions in \d+ files/m,
    );
  });

  it("keeps a multi-line description on one line", () => {
    setDescription(
      "sym:packages/utils/src/date.ts#formatRelativeDate",
      "Line one.\n- injected item\n# heading",
    );
    writeCatalog(ix.store, ix.paths);
    const line = read("packages/utils/src.md")
      .split("\n")
      .find((l) => l.includes("formatRelativeDate"));
    expect(line).toContain("Line one. - injected item # heading");
    expect(
      read("packages/utils/src.md")
        .split("\n")
        .filter((l) => l.startsWith("# ")).length,
    ).toBe(1);
  });

  it("does not rewrite unchanged directories (mtime) and rewrites only the changed one", () => {
    writeCatalog(ix.store, ix.paths);
    const old = new Date("2001-01-01T00:00:00Z");
    const all = files(ix.paths.catalogDir);
    for (const f of all) utimesSync(join(ix.paths.catalogDir, f), old, old);
    expect(writeCatalog(ix.store, ix.paths)).toBe(0);
    for (const f of all) expect(statSync(join(ix.paths.catalogDir, f)).mtime.getTime()).toBe(old.getTime());

    setDescription("sym:packages/utils/src/date.ts#formatRelativeDate", "Formats a date relative to now.");
    expect(writeCatalog(ix.store, ix.paths)).toBe(1);
    const changed = all.filter(
      (f) => statSync(join(ix.paths.catalogDir, f)).mtime.getTime() !== old.getTime(),
    );
    expect(changed).toEqual(["packages/utils/src.md"]);
    expect(read("packages/utils/src.md")).toContain("Formats a date relative to now.");
  });

  it("rewrites a file that was deleted, and removes the file of a directory that lost its functions", () => {
    writeCatalog(ix.store, ix.paths);
    writeFileSync(join(ix.paths.catalogDir, "packages/utils/src.md"), "tampered");
    // content on disk differs but the hash in meta matches: only a missing file is repaired
    expect(writeCatalog(ix.store, ix.paths)).toBe(0);
    ix.store.db
      .prepare("UPDATE meta SET value = 'x' WHERE key = 'catalog_hash:dir:packages/utils/src'")
      .run();
    expect(writeCatalog(ix.store, ix.paths)).toBe(1);
    expect(read("packages/utils/src.md").startsWith(CATALOG_NOTE)).toBe(true);

    ix.store.db
      .prepare(
        "UPDATE meta SET key = 'catalog_hash:dir:gone/dir' WHERE key = 'catalog_hash:dir:packages/db/src'",
      )
      .run();
    expect(writeCatalog(ix.store, ix.paths)).toBe(1); // packages/db/src comes back, gone/dir is dropped
    expect(ix.store.getMeta("catalog_hash:dir:gone/dir")).toBeUndefined();
  });

  it("debounces: a second call within 30 seconds does nothing", () => {
    const t0 = 1_000_000;
    expect(writeCatalogDebounced(ix.store, ix.paths, t0)).toBeGreaterThan(0);
    setDescription("sym:packages/utils/src/date.ts#formatRelativeDate", "Changed.");
    expect(writeCatalogDebounced(ix.store, ix.paths, t0 + CATALOG_DEBOUNCE_MS - 1)).toBe(0);
    expect(writeCatalogDebounced(ix.store, ix.paths, t0 + CATALOG_DEBOUNCE_MS)).toBe(1);
  });
});

describe("browse", () => {
  it("lists the files of a workspace with function counts", () => {
    const r = browse(ix.store, "ws:@acme/utils");
    const byName = Object.fromEntries(r.items.map((i) => [i.name, i]));
    expect(r.items.every((i) => i.kind === "dir" || i.kind === "file")).toBe(true);
    expect(byName["src"]).toMatchObject({ kind: "dir", id: "dir:packages/utils/src" });
    expect((byName["src"]?.count ?? 0) > 0).toBe(true);
    const inSrc = browse(ix.store, "packages/utils/src");
    const names = inSrc.items.map((i) => i.name);
    expect(names).toEqual([...names].sort());
    expect(inSrc.items.find((i) => i.path === "packages/utils/src/date.ts")).toMatchObject({
      kind: "file",
      count: 1,
    });
    expect(inSrc.catalogPath).toBe("packages/utils/src.md");
    expect(r.catalogPath).toBe("INDEX.md"); // packages/utils itself defines no functions
  });

  it("lists the symbols of a file with their descriptions, and accepts ids and names", () => {
    setDescription("sym:packages/utils/src/date.ts#formatRelativeDate", "Formats a date relative to now.");
    const r = browse(ix.store, "packages/utils/src/date.ts");
    expect(r.items[0]).toMatchObject({
      name: "formatRelativeDate",
      kind: "function",
      exported: true,
      description: "Formats a date relative to now.",
    });
    expect(r.catalogPath).toBe("packages/utils/src.md");
    expect(browse(ix.store, "file:packages/utils/src/date.ts").items).toEqual(r.items);
    expect(browse(ix.store, "@acme/utils").items).toEqual(browse(ix.store, "ws:@acme/utils").items);
    expect(browse(ix.store, "dir:packages/utils/src/").items).toEqual(
      browse(ix.store, "packages/utils/src").items,
    );
  });

  it("lists the repo root and rejects unknown targets", () => {
    const root = browse(ix.store, ".");
    expect(root.items.map((i) => i.name)).toContain("packages");
    expect(() => browse(ix.store, "no/such/dir")).toThrow(BrowseTargetError);
  });
});

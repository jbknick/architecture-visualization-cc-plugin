import { writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { adviseReuse } from "../advice/index.js";
import { cleanupData, type Indexed, indexedFixture } from "../describe/testkit.js";
import { refreshWorking } from "../heal/index.js";
import { dumpGraph, indexRepo } from "../indexer.js";
import { openStore, type Store } from "./index.js";

// Issue #105: file directives are file data, not a self import edge.
const CLIENT = "apps/api/src/client.tsx";
const PLAIN = "apps/api/src/plain.ts";
const SOURCES = {
  "packages/ui/src/index.ts":
    'export { Button } from "./button";\nexport { Card } from "./card";\nexport { readSecret } from "./secret";\n',
  "packages/ui/package.json": JSON.stringify({
    name: "@acme/ui",
    version: "0.0.0",
    private: true,
    type: "module",
    exports: { ".": "./src/index.ts", "./button": "./src/button.tsx" },
    dependencies: { react: "^19.0.0", "server-only": "^0.0.1" },
  }),
  "packages/ui/src/secret.ts":
    'import "server-only";\nexport function readSecret(key: string) {\n  return key.toUpperCase();\n}\n',
  [CLIENT]: '"use client";\nexport function Widget() {\n  return <div />;\n}\n',
  [PLAIN]: "export function plain() {\n  return 1;\n}\n",
};

const open: Indexed[] = [];
async function fixture(): Promise<Indexed> {
  const ix = await indexedFixture("pnpm-turbo", SOURCES);
  open.push(ix);
  return ix;
}
afterAll(async () => {
  for (const ix of open.splice(0)) await ix.close();
  cleanupData();
});

function secretOf(s: Store) {
  const sym = s.getSymbol("sym:packages/ui/src/secret.ts#readSecret");
  if (!sym) throw new Error("no secret symbol");
  return sym;
}

describe("dumpGraph directives", () => {
  it("adds directives to a file row only when non-empty", async () => {
    const ix = await fixture();
    const files = dumpGraph(ix.store).files as { id: string; directives?: string[] }[];
    expect(files.find((f) => f.id === `file:${CLIENT}`)?.directives).toEqual(["use client"]);
    const plain = files.find((f) => f.id === `file:${PLAIN}`);
    expect(plain).toBeDefined();
    expect(plain && "directives" in plain).toBe(false);
    expect(files.filter((f) => "directives" in f)).toHaveLength(1);
  });
});

describe("pre-v3 database", () => {
  it("migrates in place, old rows have no directives, a re-index fills them", async () => {
    const ix = await fixture();
    // Turn the freshly indexed database into a v2 one: no column, schema_version 2.
    ix.store.close();
    const raw = new Database(ix.paths.dbPath);
    raw.exec("ALTER TABLE files DROP COLUMN directives");
    raw.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    raw.close();

    const s = openStore(ix.paths.dbPath);
    try {
      expect(s.getMeta("schema_version")).toBe("3");
      expect(s.effectiveFile(`file:${CLIENT}`)).toBeDefined();
      expect(s.effectiveFile(`file:${CLIENT}`)?.directives).toBeUndefined();
      // Behaves as "no directive": no boundary crossing is reported until re-indexed.
      expect(adviseReuse(s, CLIENT, secretOf(s))[0]?.situation).not.toBe(4);
    } finally {
      s.close();
    }

    await indexRepo(ix.paths, { layer: "main" });
    const after = openStore(ix.paths.dbPath);
    try {
      expect(after.effectiveFile(`file:${CLIENT}`)?.directives).toEqual(["use client"]);
      expect(adviseReuse(after, CLIENT, secretOf(after))[0]?.situation).toBe(4);
    } finally {
      after.close();
    }
    ix.store = openStore(ix.paths.dbPath); // keep the shared cleanup valid
  });
});

describe("working layer carries directives", () => {
  it("shows an added directive and drops it again on revert", async () => {
    const ix = await fixture();
    const effective = () => {
      const s = openStore(ix.paths.dbPath);
      try {
        return s.effectiveFile(`file:${PLAIN}`)?.directives;
      } finally {
        s.close();
      }
    };
    expect(effective()).toBeUndefined();

    writeFileSync(join(ix.fx.dir, PLAIN), '"use client";\nexport function plain() {\n  return 1;\n}\n');
    await refreshWorking(ix.paths);
    expect(effective()).toEqual(["use client"]);
    const s = openStore(ix.paths.dbPath);
    try {
      expect(s.effectiveEdges({ kind: ["imports"] }).filter((e) => e.src === e.dst)).toEqual([]);
    } finally {
      s.close();
    }

    writeFileSync(join(ix.fx.dir, PLAIN), SOURCES[PLAIN]); // revert
    await refreshWorking(ix.paths);
    expect(effective()).toBeUndefined();
  });
});

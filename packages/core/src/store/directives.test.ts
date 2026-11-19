import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupData, type Indexed, indexedFixture } from "../describe/testkit.js";
import { refreshWorking } from "../heal/index.js";
import { dumpGraph } from "../indexer.js";
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

function _secretOf(s: Store) {
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

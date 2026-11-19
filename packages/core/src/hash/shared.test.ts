import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { languageModule } from "../lang/index.js";
import { parseSource } from "../parse/index.js";
import { hashSymbol } from "./index.js";
import { hashStreams } from "./shared.js";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

describe("hashStreams (shared hashing)", () => {
  it("gives the five values hashSymbol gives, for every symbol of the four fixtures", () => {
    const ts = languageModule("typescript");
    let n = 0;
    for (const fx of ["single-pkg", "pnpm-turbo", "nx", "react-router-fastify"]) {
      for (const abs of sources(join(fixturesRoot, fx))) {
        const source = readFileSync(abs, "utf8");
        const parsed = parseSource("fx", abs, source);
        for (const sym of parsed.symbols) {
          const range = parsed.bodies.get(sym.id);
          if (!range) continue;
          expect(hashStreams(ts.streams(source, range, abs))).toEqual(hashSymbol(source, range, abs));
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(20);
  });

  it("substitutes $0 at selfRefs for renamedHash and nearMinhash only", () => {
    const a = hashStreams({ exact: ["f", "x", "f"], shape: ["a", "b", "c"], selfRefs: [0, 2] });
    const b = hashStreams({ exact: ["g", "x", "g"], shape: ["a", "b", "c"], selfRefs: [0, 2] });
    expect(a.renamedHash).toBe(b.renamedHash);
    expect(a.exactHash).not.toBe(b.exactHash);
    expect(a.shapeHash).toBe(b.shapeHash);
    expect(a.minhash).toEqual(b.minhash);
  });
});

import { rmSync } from "node:fs";
import { contentKey, type GantryConfig, type Store } from "@gantry/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureStore } from "../testkit.js";
import { adviceFor } from "./dupAdvice.js";

const KEEP = "sym:pnpm-turbo:packages/utils/src/slug.ts#slugify";
const MARKER = "ZetaNineSuggestedMarker";

let store: Store;
let dir: string;

beforeAll(() => {
  ({ store, dir } = fixtureStore("pnpm-turbo"));
  const keep = store.getSymbol(KEEP);
  if (!keep) throw new Error(KEEP);
  store.db
    .prepare(
      `INSERT OR REPLACE INTO descriptions(content_key, behavior, search_terms, name_fits, suggested_name,
         provenance, model, prompt_version, created_at) VALUES (?, 'Makes a slug.', '[]', 0, ?, 'model', 'test', 'p1', 'now')`,
    )
    .run(contentKey(keep.exactHash), MARKER);
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("adviceFor rename suggestions (#118)", () => {
  const keep = () => {
    const s = store.getSymbol(KEEP);
    if (!s) throw new Error(KEEP);
    return s;
  };

  it("puts the suggested name only in untrusted_suggested_name, never in the action text", () => {
    const config = { renameSuggestions: true } as GantryConfig;
    const advice = adviceFor(store, config, "packages/utils/src/slug.ts", "pnpm-turbo", keep());
    expect(advice).toMatchObject({ situation: 5, untrusted_suggested_name: MARKER });
    expect(advice?.action).not.toContain(MARKER);
    expect(advice?.action).toContain("untrusted_suggested_name");
  });

  it("says nothing about names while renameSuggestions is off", () => {
    const config = { renameSuggestions: false } as GantryConfig;
    expect(
      JSON.stringify(adviceFor(store, config, "packages/utils/src/slug.ts", "pnpm-turbo", keep()) ?? null),
    ).not.toContain(MARKER);
  });
});

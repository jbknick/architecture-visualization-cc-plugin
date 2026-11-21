// Snapshot of the comment for a real review + duplicates pair (issue #282): `gantry review --json` and
// `gantry duplicates --since --json` as printed on fixtures/pnpm-turbo with a branch that adds a copy of `slugify`.
// The pair in action/testdata/ is written by `pnpm build && pnpm action:e2e --write-pair action/testdata` (commits with
// fixed dates, so the same bytes every time). The rendered comment is compared with action/testdata/comment.md byte
// for byte; after an intended change to the comment run the tests with UPDATE_ACTION_SNAPSHOT=1 and review the diff.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildComment, type DuplicatesJson, MARKER, type ReviewJson } from "./comment.js";

const dir = join(import.meta.dirname, "../testdata");
const read = (name: string): string => readFileSync(join(dir, name), "utf8");

const render = (): string =>
  buildComment({
    review: JSON.parse(read("review.json")) as ReviewJson,
    duplicates: JSON.parse(read("duplicates.json")) as DuplicatesJson,
    hasRecipe: false,
    embed: false,
    version: "0.1.0",
  });

describe("comment for the pnpm-turbo fixture with a copy of slugify", () => {
  it("is the same bytes on every run and matches the committed snapshot", () => {
    const body = render();
    expect(render()).toBe(body);
    if (process.env.UPDATE_ACTION_SNAPSHOT === "1") writeFileSync(join(dir, "comment.md"), body);
    expect(body).toBe(read("comment.md"));
  });

  it("lists the added slugify copy as a duplicate, with its other copies and its consumers", () => {
    const body = render();
    expect(body.startsWith(`${MARKER}\n`)).toBe(true);
    expect(body).toContain("### Duplicates");
    expect(body).toContain("1. **exact**, 3 functions");
    expect(body).toContain("keep `packages/ui/src/slug-copy.ts:2 slugify` **added here**");
    expect(body).toContain("`apps/web/src/lib/slug.ts:1 slugify` (exact 1.00)");
    expect(body).toContain("`packages/utils/src/slug.ts:2 slugify` (exact 1.00)");
    expect(body).toContain("### Consumers");
    expect(body).toContain("<summary>`slugify`: 1 direct, 0 potential</summary>");
    expect(body).toContain("`SLUG_VERSION (const, packages/ui/src/slug-copy.ts:11) calls`");
    expect(body).toContain("Structural radius only");
  });
});

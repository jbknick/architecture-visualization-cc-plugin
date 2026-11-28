import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildComment,
  type CommentInput,
  type CrossingFinding,
  code,
  GITHUB_COMMENT_LIMIT,
  MARKER,
  MAX_BODY,
  nameOfId,
  type ReviewJson,
} from "./comment.js";
import { sampleDuplicates, sampleReview } from "./sample.js";

const input = (over: Partial<CommentInput> = {}): CommentInput => ({
  review: sampleReview(),
  duplicates: sampleDuplicates(),
  hasRecipe: true,
  embed: false,
  ...over,
});

describe("comment body", () => {
  it("starts with the hidden marker and shows risk, duplicates, changed symbols, crossings and consumers", () => {
    const body = buildComment(input());
    expect(body.startsWith(`${MARKER}\n`)).toBe(true);
    expect(body).toContain("**Risk: medium (45/100)**");
    expect(body).toContain("### Duplicates");
    expect(body).toContain("**changed here**"); // doThing0 is a modified symbol and the group's keep candidate
    expect(body).toContain("### Changed symbols (2)");
    expect(body).toContain("### Crossings (2)");
    expect(body).toContain("### Consumers");
    expect(body).toContain("Directly affected (3):");
    expect(body).toContain("Potentially affected (3):");
    expect(body).toContain("duplicate tiers: exact and near");
    expect(body).not.toContain("Structural radius only");
  });

  it("says when the radius is structural only, and when code vectors are on", () => {
    const body = buildComment(input({ hasRecipe: false, embed: true }));
    expect(body).toContain("Structural radius only");
    expect(body).toContain("exact, near and code-vector");
  });

  it("lists the top 10 direct and top 10 potential consumers of a change, with path:line, and counts the rest", () => {
    const body = buildComment(input({ review: sampleReview({ symbols: 1, consumersPer: 14 }) }));
    const direct = body.split("Potentially affected")[0] ?? "";
    expect(direct.match(/^- `caller/gm)).toHaveLength(10);
    expect(direct).toContain("- and 4 more");
    const potential = body.split("Potentially affected")[1] ?? "";
    expect(potential.match(/^- `caller/gm)).toHaveLength(10);
    expect(potential).toContain("- and 4 more");
    expect(body).toMatch(/- `caller0 \(function, apps\/web\/src\/use0-0-1\.ts:1\)/);
  });

  it("shows the reachable total and the hubs on deep-radius, and neither when the tier is empty", () => {
    const deep = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../fixtures/deep-radius.review.json"), "utf8"),
    ) as ReviewJson;
    const body = buildComment(input({ review: deep }));
    expect(body).toContain("Reachable (4+ hops): 615");
    expect(body).toContain("Hubs: `hub` (610)");
    const plain = buildComment(input());
    expect(plain).not.toContain("Reachable (4+ hops)");
    expect(plain).not.toContain("Hubs:");
  });

  it("is the same text every time", () => {
    expect(buildComment(input())).toBe(buildComment(input()));
  });

  it("says so when there are no duplicates or the duplicate check did not run", () => {
    expect(
      buildComment(
        input({
          duplicates: {
            summary: { clusters: 0, functions: 0, duplicateLines: 0, crossWorkspace: 0 },
            clusters: [],
          },
        }),
      ),
    ).toContain("No duplicates in the code this pull request adds or changes.");
    const failed = buildComment(
      input({ duplicates: null, duplicatesError: "gantry duplicates failed (exit 1)" }),
    );
    expect(failed).toContain("The duplicate check did not run");
    // the review's own duplicate notes stay when the check did not run
    expect(failed).toContain("New function sym:repo:a.ts#f duplicates");
    expect(buildComment(input())).not.toContain("New function sym:repo:a.ts#f duplicates");
  });

  it("handles a range with no impact data and no changed symbols", () => {
    const noIndex = { ...sampleReview(), impact: null };
    expect(buildComment(input({ review: noIndex }))).toContain("No impact data");
    const empty = sampleReview({ symbols: 0 });
    expect(buildComment(input({ review: empty }))).toContain("No indexed symbols changed");
  });

  it("keeps names from the repository inside code spans", () => {
    const review = sampleReview();
    const evil = "a`b|c\n[x](http://evil.example) @someone <img src=x>";
    const first = review.changes[0];
    if (!first?.after) throw new Error("sample has a change");
    first.after.path = evil;
    const body = buildComment(input({ review }));
    expect(body).not.toContain("a`b");
    expect(body).toContain("`a'b\\|c [x](http://evil.example) @someone <img src=x>:10`");
    expect(body.split("\n").every((l) => !l.includes("\r"))).toBe(true);
  });

  it("removes invisible format characters and collapses odd spaces in a code span", () => {
    expect(code("ui\u200b\u200dx\u202eevil\u2066")).toBe("`uixevil`");
    expect(code(`Orders${String.fromCodePoint(0xe0069, 0xe0067, 0xe006e)}`)).toBe("`Orders`");
    expect(code("a\u00a0\u3000b\ue000c\ud800d")).toBe("`a bcd`");
    expect(code("\u200b\u202e")).toBe("`-`");
  });

  it("names a node from its id", () => {
    expect(nameOfId("sym:repo:src/a.ts#f")).toBe("f");
    expect(nameOfId("file:repo:src/a.ts")).toBe("src/a.ts");
    expect(code("")).toBe("`-`");
    expect(code("x".repeat(500), 10)).toBe(`\`${"x".repeat(9)}…\``);
  });

  it("stays under the size limit when everything is huge", () => {
    // 2,000 changed symbols with 200 consumers each, 150-character names, 500 duplicate groups.
    const review = sampleReview({ symbols: 2000, consumersPer: 200, nameLength: 150 });
    if (review.impact) {
      review.impact.notes = Array.from({ length: 300 }, (_, i) => `note ${i} ${"y".repeat(2000)}`);
      review.impact.risk.reasons = Array.from({ length: 50 }, (_, i) => `reason ${i} ${"z".repeat(1000)}`);
    }
    const body = buildComment(input({ review, duplicates: sampleDuplicates(500) }));
    expect(body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(MAX_BODY).toBeLessThan(GITHUB_COMMENT_LIMIT);
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain("**Risk: medium (45/100)**");
    expect(body).toContain("### Duplicates");
  });

  it("drops the least important sections first, then cuts, to fit a smaller limit", () => {
    const full = buildComment(input({ review: sampleReview({ symbols: 20, consumersPer: 5 }) }));
    const noConsumers = buildComment(
      input({ review: sampleReview({ symbols: 20, consumersPer: 5 }) }),
      full.length - 1,
    );
    expect(noConsumers.length).toBeLessThanOrEqual(full.length - 1);
    expect(noConsumers).not.toContain("### Consumers");
    expect(noConsumers).toContain("### Changed symbols");
    expect(noConsumers).toContain("left out to stay under GitHub's comment size limit");

    const cut = buildComment(input({ review: sampleReview({ symbols: 20, consumersPer: 5 }) }), 700);
    expect(cut.length).toBeLessThanOrEqual(700);
    expect(cut.startsWith(MARKER)).toBe(true);
    expect(cut).toContain("left out to stay under GitHub's comment size limit");
  });

  it("is bounded for a one-line input of a million characters per field", () => {
    const review = sampleReview({ symbols: 40, consumersPer: 5, nameLength: 1_000_000 });
    const body = buildComment(input({ review }));
    expect(body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(body.startsWith(MARKER)).toBe(true);
  });
});

const found = (
  srcGroup: string,
  dstGroup: string,
  srcName: string,
  dstName: string,
  over: Partial<CrossingFinding> = {},
): CrossingFinding => ({
  kind: "crossing",
  srcName,
  srcPath: `src/${srcGroup.toLowerCase()}/a.ts`,
  srcLine: 3,
  srcGroup,
  dstName,
  dstPath: `src/${dstGroup.toLowerCase()}/b.ts`,
  dstLine: 1,
  dstGroup,
  team: true,
  ...over,
});
const team = (crossings: CrossingFinding[]): CommentInput["teamBoundaries"] => ({
  crossings,
  total: crossings.length,
});
const sectionOf = (body: string): string =>
  body.slice(body.indexOf("### Team boundaries"), body.indexOf("### Consumers"));

describe("team boundaries section", () => {
  it("lists the pairs of groups sorted by name, 3 items per pair, the pair's total, between Crossings and Consumers", () => {
    const body = buildComment(
      input({
        teamBoundaries: team([
          found("Payments", "Shipping", "shippingCost", "rateFor"),
          found("Payments", "Checkout", "applyDiscount", "getCart"),
          found("Payments", "Checkout", "totalWithTax", "getCart"),
          found("Payments", "Checkout", "roundCents", "getCart"),
          found("Payments", "Checkout", "fourth", "getCart"),
          found("Payments", "Checkout", "fifth", "getCart"),
        ]),
      }),
    );
    expect(sectionOf(body)).toBe(
      [
        "### Team boundaries (2)",
        "",
        "- `Payments` → `Checkout`: `applyDiscount` uses `getCart`, `totalWithTax` uses `getCart`, `roundCents` uses `getCart` (5 edges in total)",
        "- `Payments` → `Shipping`: `shippingCost` uses `rateFor` (1 edge in total)",
        "",
        "",
      ].join("\n"),
    );
    expect(body.indexOf("### Crossings")).toBeLessThan(body.indexOf("### Team boundaries"));
    expect(body.indexOf("### Team boundaries")).toBeLessThan(body.indexOf("### Consumers"));
    // The Crossings section is the one that was there before.
    expect(body).toContain("### Crossings (2)");
  });

  it("shows file paths for an added import", () => {
    const body = buildComment(
      input({
        teamBoundaries: team([
          found("Orders", "Catalog", "src/orders/a.ts", "src/catalog/b.ts", {
            srcPath: "src/orders/a.ts",
            dstPath: "src/catalog/b.ts",
            srcLine: 0,
            dstLine: 0,
          }),
        ]),
      }),
    );
    expect(sectionOf(body)).toContain(
      "- `Orders` → `Catalog`: `src/orders/a.ts` uses `src/catalog/b.ts` (1 edge in total)",
    );
  });

  it("shows 10 pairs and counts the rest: 12 pairs end with and 2 more", () => {
    const crossings = Array.from({ length: 12 }, (_, i) =>
      found(`Team${String(i).padStart(2, "0")}`, "Core", `fn${i}`, "helper"),
    );
    const section = sectionOf(buildComment(input({ teamBoundaries: team(crossings) })));
    expect(section.startsWith("### Team boundaries (12)\n")).toBe(true);
    expect(section.match(/^- `Team/gm)).toHaveLength(10);
    expect(section).toContain("- and 2 more\n");
  });

  it("escapes group and function names: no backtick, link, mention or line break gets out", () => {
    const body = buildComment(
      input({
        teamBoundaries: team([found("A`b\n[x](http://evil) @all", "<img src=x>", "f`n\n# head", "g | h")]),
      }),
    );
    const section = sectionOf(body);
    expect(section.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
    expect(section).toContain("- `A'b [x](http://evil) @all` → `<img src=x>`: `f'n # head` uses `g | h`");
  });

  it("is absent, and the body is byte-identical, with no team values, null or none found", () => {
    const plain = buildComment(input());
    expect(buildComment(input({ teamBoundaries: null }))).toBe(plain);
    expect(buildComment(input({ teamBoundaries: team([]) }))).toBe(plain);
    expect(plain).not.toContain("Team boundaries");
  });

  it("is dropped after consumers and notes, and before Crossings, when the comment is too long", () => {
    const base = input({
      review: sampleReview({ symbols: 20, consumersPer: 5 }),
      teamBoundaries: team([found("Orders", "Catalog", "totalDue", "formatPrice")]),
    });
    const full = buildComment(base);
    // The size at which each heading first disappears, as the limit falls from the full length.
    const goneAt = new Map<string, number>();
    for (let limit = full.length; limit >= 0 && goneAt.size < 4; limit--) {
      const body = buildComment(base, limit);
      for (const h of ["### Consumers", "### Notes", "### Team boundaries", "### Crossings"]) {
        if (!goneAt.has(h) && !body.includes(h)) goneAt.set(h, limit);
      }
    }
    const at = (h: string): number => goneAt.get(h) ?? -1;
    expect(at("### Consumers")).toBeGreaterThan(at("### Notes"));
    expect(at("### Notes")).toBeGreaterThan(at("### Team boundaries"));
    expect(at("### Team boundaries")).toBeGreaterThan(at("### Crossings"));
    expect(at("### Crossings")).toBeGreaterThan(0);
  });
});

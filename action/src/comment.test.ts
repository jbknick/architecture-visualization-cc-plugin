import { describe, expect, it } from "vitest";
import {
  buildComment,
  type CommentInput,
  code,
  GITHUB_COMMENT_LIMIT,
  MARKER,
  MAX_BODY,
  nameOfId,
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

import { describe, expect, it } from "vitest";
import { type DupFinding, formatCapped, formatFinding, formatLines, type ImportLine } from "./findings.js";

const dup = (i: number): DupFinding => ({
  kind: "duplicate",
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
const imp: ImportLine = { kind: "import", line: 4, action: 'Declare "@acme/db" in apps/web/package.json' };

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

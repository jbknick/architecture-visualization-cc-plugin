// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ellipsizeMiddle,
  fitCellLabel,
  layoutTreemap,
  squarify,
  TM_PAD,
  type TmNode,
  wrapText,
} from "./treemap.ts";
import type { Rect } from "./types.ts";

const area = (r: Rect) => r.w * r.h;
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;
const inside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x - 1e-6 &&
  inner.y >= outer.y - 1e-6 &&
  inner.x + inner.w <= outer.x + outer.w + 1e-6 &&
  inner.y + inner.h <= outer.y + outer.h + 1e-6;

const items = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, weight: 1 + ((i * 7) % 13) }));

describe("squarify", () => {
  const rect = { x: 10, y: 20, w: 400, h: 250 };

  it("gives every item an area proportional to its weight", () => {
    const placed = squarify(items, rect);
    const total = items.reduce((s, i) => s + i.weight, 0);
    expect(placed).toHaveLength(items.length);
    for (const p of placed) {
      const w = (items.find((i) => i.id === p.id) as { weight: number }).weight;
      expect(area(p.rect)).toBeCloseTo((w / total) * area(rect), 6);
    }
    expect(placed.reduce((s, p) => s + area(p.rect), 0)).toBeCloseTo(area(rect), 6);
  });

  it("never overlaps and stays inside the parent", () => {
    const placed = squarify(items, rect);
    for (let a = 0; a < placed.length; a++) {
      expect(inside((placed[a] as { rect: Rect }).rect, rect)).toBe(true);
      for (let b = a + 1; b < placed.length; b++) {
        expect(overlaps((placed[a] as { rect: Rect }).rect, (placed[b] as { rect: Rect }).rect)).toBe(false);
      }
    }
  });

  it("is deterministic whatever the input order, with ties broken by id", () => {
    const a = squarify(items, rect);
    const b = squarify([...items].reverse(), rect);
    expect(b).toEqual(a);
    const ties = squarify(
      [
        { id: "b", weight: 2 },
        { id: "a", weight: 2 },
      ],
      rect,
    );
    expect(ties.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("keeps cells reasonably square", () => {
    const worst = Math.max(
      ...squarify(items, rect).map((p) => Math.max(p.rect.w / p.rect.h, p.rect.h / p.rect.w)),
    );
    expect(worst).toBeLessThan(6);
  });

  it("handles one item, empty input and zero weights", () => {
    expect(squarify([], rect)).toEqual([]);
    expect(squarify([{ id: "x", weight: 0 }], rect)).toEqual([]);
    expect(squarify([{ id: "x", weight: 5 }], rect)[0]?.rect).toEqual(rect);
  });
});

function tree(): TmNode {
  const file = (id: string, fns: number): TmNode => ({
    id,
    weight: Math.max(fns, 0.6),
    head: 0,
    children: [],
  });
  const dir = (id: string, children: TmNode[]): TmNode => ({ id, weight: 0, head: 16, children });
  return {
    id: "ws",
    weight: 0,
    head: 60,
    children: [
      dir("d1", [file("a", 40), file("b", 12), file("c", 0), file("d", 3)]),
      dir("d2", [file("e", 30), dir("d3", [file("f", 9), file("g", 9)])]),
      dir("d4", [file("h", 5)]),
    ],
  };
}

describe("layoutTreemap", () => {
  const rect = { x: 0, y: 0, w: 640, h: 420 };

  it("puts every child inside its parent, below the header, without sibling overlaps", () => {
    const root = tree();
    const out = layoutTreemap(root, rect);
    const walk = (n: TmNode) => {
      const r = out.rects.get(n.id) as Rect;
      const head = out.heads.get(n.id) ?? 0;
      const kids = n.children.map((c) => out.rects.get(c.id) as Rect);
      for (const k of kids) {
        expect(inside(k, r)).toBe(true);
        if (head > 0) expect(k.y).toBeGreaterThanOrEqual(r.y + head - 1e-6);
      }
      for (let a = 0; a < kids.length; a++)
        for (let b = a + 1; b < kids.length; b++)
          expect(overlaps(kids[a] as Rect, kids[b] as Rect)).toBe(false);
      n.children.forEach(walk);
    };
    walk(root);
  });

  it("sizes sibling areas in proportion to their weight, zero-function files included as thin cells", () => {
    const out = layoutTreemap(tree(), rect);
    const a = out.rects.get("a") as Rect;
    const b = out.rects.get("b") as Rect;
    const c = out.rects.get("c") as Rect;
    const d = out.rects.get("d") as Rect;
    expect(area(a) / area(b)).toBeCloseTo(40 / 12, 6);
    expect(area(b) / area(d)).toBeCloseTo(12 / 3, 6);
    expect(area(c)).toBeGreaterThan(0);
    expect(area(c)).toBeLessThan(area(d));
  });

  it("is deterministic", () => {
    const first = [...layoutTreemap(tree(), rect).rects];
    const second = [...layoutTreemap(tree(), rect).rects];
    expect(second).toEqual(first);
  });

  it("drops the header of a container that is too short for it and keeps the padding", () => {
    const out = layoutTreemap(tree(), { x: 0, y: 0, w: 640, h: 80 });
    expect(out.heads.get("ws")).toBe(0); // 80 < 2.2 * 60
    const r = out.rects.get("d1") as Rect;
    expect(r.y).toBeGreaterThanOrEqual(TM_PAD - 1e-6);
  });
});

describe("label fit rule", () => {
  // 6px per character keeps the arithmetic obvious.
  const measure = (t: string) => t.length * 6;

  it("draws a label only when it fits inside the cell at 10px or more", () => {
    expect(fitCellLabel(measure, "button.tsx", 80, 16, 10)).toBe("button.tsx");
    expect(fitCellLabel(measure, "button.tsx", 80, 11, 10)).toBeNull(); // too short for the font
    expect(fitCellLabel(measure, "button.tsx", 80, 16, 9)).toBeNull(); // font below the floor
    expect(fitCellLabel(measure, "button.tsx", 40, 16, 10)).toBeNull(); // too narrow, no ellipsis under 60px
  });

  it("ellipsizes the middle of long names only in cells of 60px or more", () => {
    const long = "customerInvoiceRepositoryAdapter.ts";
    const label = fitCellLabel(measure, long, 120, 16, 11) as string;
    expect(label).toContain("…");
    expect(measure(label)).toBeLessThanOrEqual(120 - 6);
    expect(label.startsWith("customer")).toBe(true);
    expect(label.endsWith(".ts")).toBe(true);
    expect(fitCellLabel(measure, long, 59, 16, 11)).toBeNull();
  });

  it("ellipsizeMiddle keeps both ends and the requested length", () => {
    expect(ellipsizeMiddle("abcdefghij", 20)).toBe("abcdefghij");
    const e = ellipsizeMiddle("abcdefghijklmnop", 9);
    expect(e).toHaveLength(9);
    expect(e).toContain("…");
  });

  it("wrapText wraps at separators and never drops characters", () => {
    const lines = wrapText(measure, "acme-platform-monorepo/db-client", 100);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(measure(l)).toBeLessThanOrEqual(100);
    expect(lines.join("").replace(/\s/g, "")).toBe("acme-platform-monorepo/db-client");
    expect(wrapText(measure, "short", 100)).toEqual(["short"]);
    expect(wrapText(measure, "unbreakablewordthatislong", 60).join("")).toBe("unbreakablewordthatislong");
  });
});

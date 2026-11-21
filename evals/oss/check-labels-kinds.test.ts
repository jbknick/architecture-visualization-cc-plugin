import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkLabels, labelCount, lastLiteralSegment } from "../../scripts/eval-label-check.js";
import { labelsSchema } from "../../scripts/eval-lib.js";

const SHA = "b".repeat(40);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function clone(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "gantry-checklabels-kinds-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const files = {
  "cmd/routes.go": 'mux.Get("/orders/{id}", h.Order)\n',
  "h/orders.go": "package h\n\nfunc (r *Repo) Order() {}\n",
  "db/q.sql": "-- name: GetOrder :one\nSELECT * FROM orders;\n",
};
const labelsOf = (over: Record<string, unknown>) =>
  labelsSchema.parse({ repo: "app", sha: SHA, labelledBy: "test", kinds: [], ...over });

describe("check-labels on endpoint, table, read and write labels", () => {
  it("accepts labels whose files and lines hold what they name", () => {
    const labels = labelsOf({
      endpoint: [{ method: "GET", path: "/orders/{id}", file: "cmd/routes.go", handler: "h/orders.go:3" }],
      table: [{ name: "orders" }],
      read: [{ file: "db/q.sql", table: "orders", fns: [{ name: "GetOrder", line: 1 }] }],
      unresolved: [{ file: "cmd/routes.go", line: 1, reason: "path built at run time" }],
    });
    expect(checkLabels(labels, clone(files))).toEqual([]);
    expect(labelCount(labels)).toBe(3);
  });

  it("reports a missing file, a line past the end and a line that holds something else", () => {
    const labels = labelsOf({
      endpoint: [
        { method: "GET", path: "/orders/{id}", file: "cmd/gone.go" },
        { method: "GET", path: "/orders/{id}", file: "cmd/routes.go", handler: "h/orders.go:99" },
        { method: "POST", path: "/orders/{id}", file: "cmd/routes.go", handler: "h/orders.go:1" },
        { method: "GET", path: "/invoices", file: "cmd/routes.go" },
      ],
      read: [
        { file: "db/q.sql", table: "orders", fns: [{ name: "GetOrder", line: 2 }] },
        { file: "db/q.sql", table: "carts" },
      ],
    });
    expect(checkLabels(labels, clone(files))).toEqual([
      "endpoint GET /orders/{id}: cmd/gone.go does not exist",
      expect.stringContaining("endpoint GET /orders/{id} handler: h/orders.go:99 is past the end"),
      "endpoint POST /orders/{id} handler: line does not hold func ",
      "endpoint GET /invoices: cmd/routes.go does not hold invoices",
      "read db/q.sql orders fn GetOrder: line does not hold GetOrder",
      "read db/q.sql carts: db/q.sql does not hold carts",
    ]);
  });

  it("takes the last segment that is not a parameter or a wildcard", () => {
    expect(lastLiteralSegment("/admin/reservations/{src}/{id}")).toBe("reservations");
    expect(lastLiteralSegment("/static/*")).toBe("static");
    expect(lastLiteralSegment("/api/:slug")).toBe("api");
    expect(lastLiteralSegment("/")).toBeUndefined();
  });

  it("rejects a handler that is not path:line", () => {
    const bad = { method: "GET", path: "/x", file: "a.go", handler: "a.go" };
    expect(
      labelsSchema.safeParse({ repo: "a", sha: SHA, labelledBy: "t", kinds: [], endpoint: [bad] }).success,
    ).toBe(false);
  });
});

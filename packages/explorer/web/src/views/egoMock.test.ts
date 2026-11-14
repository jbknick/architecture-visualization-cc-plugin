import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { egoHub } from "../../mock/hubEgo.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, rel), "utf8");

describe("mock ego scenarios", () => {
  it("the mock's row budget is a copy of the server's", () => {
    const server = read("../../../server/views/egoGroups.ts").replace(
      'import { cmp, getOrInit } from "./options.js";\n',
      "",
    );
    const mock = read("../../mock/egoRows.ts");
    expect(mock.endsWith(server)).toBe(true);
  });

  it("hub-thin: 221 callers, at most 18 rows, every row a group", () => {
    const d = egoHub([], "hub-thin", 18);
    const rows = d.nodes.filter((n) => n.side === "in");
    expect(rows.length).toBeLessThanOrEqual(18);
    expect(rows.every((n) => n.kind === "group")).toBe(true);
    expect(rows.reduce((n, g) => n + g.size, 0)).toBe(221);
    const ws = new Set(rows.map((n) => n.workspace));
    expect(ws.size).toBe(2);
    expect(d.nodes.filter((n) => n.side === "out")).toHaveLength(1);
  });

  it("hub-thin: the shape of the real case", () => {
    const d = egoHub([], "hub-thin", 40);
    const members = d.nodes.flatMap((n) => n.members ?? []);
    expect(members).toHaveLength(221);
    const web = members.filter((m) => m.path?.startsWith("apps/customer-portal-web/"));
    expect(web).toHaveLength(201);
    const files = new Set(web.map((m) => m.path));
    expect(files.size).toBe(104);
    const perFile = new Map<string, number>();
    for (const m of web) perFile.set(m.path ?? "", (perFile.get(m.path ?? "") ?? 0) + 1);
    expect([...perFile.values()].filter((n) => n <= 3).length).toBeGreaterThan(files.size * 0.7);
    const folders = new Map<string, number>();
    for (const m of web) {
      const dir = (m.path ?? "").replace(/\/[^/]+$/, "");
      folders.set(dir, (folders.get(dir) ?? 0) + 1);
    }
    expect(folders.size).toBe(30);
    expect(Math.max(...folders.values())).toBeLessThanOrEqual(11);
    const admin = members.filter((m) => m.path?.startsWith("apps/internal-admin-console/"));
    expect(admin).toHaveLength(20);
    expect(new Set(admin.map((m) => m.path)).size).toBe(16);
  });

  it("hub keeps its shape: callers concentrated in a few folders, 3 workspaces", () => {
    const d = egoHub([], "hub", 18);
    const rows = d.nodes.filter((n) => n.side === "in");
    expect(rows.length).toBeLessThanOrEqual(18);
    expect(rows.reduce((n, g) => n + g.size, 0)).toBe(221);
    expect(new Set(rows.map((n) => n.workspace)).size).toBe(3);
  });

  it("expanding the largest thin group adds at most 15 rows", () => {
    const base = egoHub([], "hub-thin", 18);
    const top = [...base.nodes.filter((n) => n.kind === "group")].sort((a, b) => b.size - a.size)[0];
    const d = egoHub([top?.id ?? ""], "hub-thin", 18);
    const added = d.nodes.length - base.nodes.length;
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThanOrEqual(15);
  });
});

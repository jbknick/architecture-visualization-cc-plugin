import { describe, expect, it } from "vitest";
import { cleanSql, lineInText, looksLikeSql, placeholder, refTarget, scanSql } from "./sql-text.js";

const refs = (sql: string) => scanSql(sql).map((r) => `${r.kind}:${r.ref}`);

describe("sql-text", () => {
  it("reads SELECT ... FROM and JOIN, writes INSERT INTO, UPDATE, DELETE FROM, declares CREATE TABLE", () => {
    expect(refs("SELECT * FROM jobs j JOIN queues q ON q.id = j.queue_id")).toEqual([
      "read:jobs",
      "read:queues",
    ]);
    expect(refs("INSERT INTO jobs (id) VALUES ($1)")).toEqual(["write:jobs"]);
    expect(refs("UPDATE jobs SET state = 'done' WHERE id = $1")).toEqual(["write:jobs"]);
    expect(refs("update jobs as j set state = 'x'")).toEqual(["write:jobs"]);
    expect(refs("DELETE FROM jobs WHERE id = $1")).toEqual(["write:jobs"]);
    expect(refs("TRUNCATE TABLE jobs")).toEqual(["write:jobs"]);
    expect(refs("CREATE TABLE IF NOT EXISTS public.jobs (id int)")).toEqual(["create:public.jobs"]);
  });

  it("does not take the table of DELETE FROM as a read, and skips function calls after FROM", () => {
    expect(refs("DELETE FROM jobs")).toEqual(["write:jobs"]);
    expect(refs("SELECT * FROM generate_series(1, 3)")).toEqual([]);
  });

  it("skips names a WITH clause defines, and reads the tables around them", () => {
    expect(
      refs("WITH recent AS (SELECT * FROM jobs) SELECT * FROM recent r JOIN queues q ON q.id = r.q"),
    ).toEqual(["read:jobs", "read:queues"]);
  });

  it("reads comma-separated tables after FROM, with and without aliases", () => {
    expect(refs("SELECT 1 FROM a x, b y, c WHERE x.id = y.id")).toEqual(["read:a", "read:b", "read:c"]);
  });

  it("ignores comments and string literals", () => {
    expect(refs("-- FROM hidden\nSELECT 'FROM nowhere' AS s FROM real /* JOIN gone */")).toEqual([
      "read:real",
    ]);
    expect(cleanSql("a 'b c' --d\ne")).toHaveLength("a 'b c' --d\ne".length);
  });

  it("keeps schema-qualified and quoted names, and tells the table from a substitution", () => {
    const r = scanSql(`SELECT * FROM ${placeholder(0)}.job JOIN "My Table" ON true`);
    expect(r.map((x) => refTarget(x.ref))).toEqual([{ name: "job" }, { name: "My Table" }]);
    const rt = scanSql(`SELECT * FROM ${placeholder(0)}.${placeholder(1)}`);
    expect(refTarget(rt[0]?.ref ?? "")).toEqual({ placeholder: 1 });
  });

  it("recognizes text that holds a statement shape anywhere", () => {
    expect(looksLikeSql("select a from b")).toBe(true);
    expect(looksLikeSql("(SELECT x FROM y)")).toBe(true);
    expect(looksLikeSql("INSERT INTO t")).toBe(true);
    expect(looksLikeSql("hello from the other side")).toBe(false);
    expect(looksLikeSql("-- SELECT a FROM b")).toBe(false);
  });

  it("counts lines inside a text", () => {
    expect(lineInText("a\nb\nc", 4)).toBe(2);
  });
});

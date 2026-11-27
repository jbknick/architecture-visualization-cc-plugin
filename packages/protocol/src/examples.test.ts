import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { decodePart } from "./parts.js";
import {
  ChangeSetSchema,
  CloseRequestSchema,
  DescriptionsRequestSchema,
  ErrorSchema,
  GroupSchema,
  MainSnapshotSchema,
  PullResponseSchema,
  SavedViewSchema,
  UploadBegunSchema,
  UploadStartSchema,
  UploadStatusSchema,
  WhoamiResponseSchema,
} from "./schemas.js";

const DIR = join(import.meta.dirname, "../examples");
const schemas: Record<string, z.ZodType> = {
  "change-set.json": ChangeSetSchema,
  "close-request.json": CloseRequestSchema,
  "descriptions-request.json": DescriptionsRequestSchema,
  "error.json": ErrorSchema,
  "group.json": GroupSchema,
  "pull-response.json": PullResponseSchema,
  "upload-begun.json": UploadBegunSchema,
  "upload-start-change-set.json": UploadStartSchema,
  "upload-start-main.json": UploadStartSchema,
  "upload-status.json": UploadStatusSchema,
  "view.json": SavedViewSchema,
  "whoami-ci.json": WhoamiResponseSchema,
  "whoami-user.json": WhoamiResponseSchema,
};
const files = readdirSync(DIR);

describe("examples", () => {
  it("every file has a schema or is a part", () => {
    for (const f of files) expect(f in schemas || /\.part-\d+\.ndjson\.gz$/.test(f), f).toBe(true);
  });

  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name} parses`, () => {
      expect(schema.safeParse(JSON.parse(readFileSync(join(DIR, name), "utf8"))).success).toBe(true);
    });
  }

  it("the parts of the main snapshot rebuild a snapshot that matches its upload start", () => {
    const parts = files
      .filter((f) => f.startsWith("main-snapshot.part-"))
      .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
    expect(parts.length).toBeGreaterThan(1);
    const records = parts.flatMap((f) => decodePart(new Uint8Array(readFileSync(join(DIR, f)))));
    const start = UploadStartSchema.parse(
      JSON.parse(readFileSync(join(DIR, "upload-start-main.json"), "utf8")),
    );
    if (start.kind !== "main") throw new Error("not a main start");
    const section = (t: string) => records.filter((r) => r.t === t).map(({ t: _t, ...rest }) => rest);
    const snapshot = {
      repo: "fixture/pnpm-turbo",
      sha: start.sha,
      workspaces: section("w"),
      files: section("f"),
      symbols: section("s"),
      edges: section("e"),
      adapter_nodes: section("a"),
    };
    expect(MainSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect({
      workspaces: snapshot.workspaces.length,
      files: snapshot.files.length,
      symbols: snapshot.symbols.length,
      edges: snapshot.edges.length,
      adapter_nodes: snapshot.adapter_nodes.length,
    }).toEqual(start.counts);
  });

  it("the change set part holds its header first", () => {
    const records = decodePart(new Uint8Array(readFileSync(join(DIR, "change-set.part-1.ndjson.gz"))));
    expect(records[0]?.t).toBe("c");
    expect(records.filter((r) => r.t === "c")).toHaveLength(1);
  });
});

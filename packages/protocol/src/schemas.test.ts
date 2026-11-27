import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AdapterNodeSchema,
  ChangeSetReadSchema,
  ChangeSetRecordSchema,
  ChangeSetSchema,
  CloseRequestSchema,
  CloseResponseSchema,
  DeletedResponseSchema,
  DescriptionSchema,
  DescriptionsRequestSchema,
  DescriptionsResponseSchema,
  EdgeSchema,
  ErrorSchema,
  FileSchema,
  FilterSpecSchema,
  GroupSchema,
  LIMITS,
  MainRecordSchema,
  MainSnapshotSchema,
  PartRecordSchema,
  PullResponseSchema,
  RadiusEntrySchema,
  SavedResponseSchema,
  SavedViewSchema,
  SelectorSchema,
  SymbolSchema,
  UploadBegunSchema,
  UploadPartResponseSchema,
  UploadStartSchema,
  UploadStatusSchema,
  WhoamiResponseSchema,
  WorkspaceSchema,
} from "./schemas.js";
import { changeSet, description, group, ids, REPO, SHA, snapshot, view } from "./testing/samples.js";

const snap = snapshot();
const WITH_EXTRA = { extra: 1 };

describe("request schemas are strict", () => {
  const cases: [string, z.ZodType, unknown][] = [
    ["Workspace", WorkspaceSchema, snap.workspaces[0]],
    ["File", FileSchema, snap.files[0]],
    ["Symbol", SymbolSchema, snap.symbols[0]],
    ["AdapterNode", AdapterNodeSchema, snap.adapter_nodes[0]],
    ["Edge", EdgeSchema, snap.edges[0]],
    ["MainSnapshot", MainSnapshotSchema, snap],
    ["RadiusEntry", RadiusEntrySchema, changeSet().radius[0]],
    ["ChangeSet", ChangeSetSchema, changeSet()],
    ["Description", DescriptionSchema, description()],
    ["DescriptionsRequest", DescriptionsRequestSchema, { repo: REPO, descriptions: [description()] }],
    ["Group", GroupSchema, group],
    ["SavedView", SavedViewSchema, view],
    ["FilterSpec", FilterSpecSchema, view.spec],
    [
      "UploadStart main",
      UploadStartSchema,
      { kind: "main", sha: SHA, counts: { workspaces: 1, files: 1, symbols: 1, edges: 1, adapter_nodes: 1 } },
    ],
    ["UploadStart change_set", UploadStartSchema, { kind: "change_set", counts: { nodes: 2, radius: 2 } }],
    ["CloseRequest", CloseRequestSchema, { merged: true, head_sha: SHA }],
  ];
  for (const [name, schema, valid] of cases) {
    it(`${name} accepts a valid example and rejects an extra key`, () => {
      expect(schema.safeParse(valid).success).toBe(true);
      expect(schema.safeParse({ ...(valid as object), ...WITH_EXTRA }).success).toBe(false);
    });
  }

  it("rejects a count object with an extra key", () => {
    const start = {
      kind: "main",
      sha: SHA,
      counts: { workspaces: 1, files: 1, symbols: 1, edges: 1, adapter_nodes: 1 },
    };
    expect(UploadStartSchema.safeParse({ ...start, counts: { ...start.counts, parts: 3 } }).success).toBe(
      false,
    );
    expect(UploadStartSchema.safeParse({ ...start, parts: 3 }).success).toBe(false);
  });

  it("SymbolSchema has no shape_hash", () => {
    expect(SymbolSchema.safeParse({ ...snap.symbols[0], shape_hash: ids.HASH }).success).toBe(false);
  });

  it("rejects a snapshot that carries source text", () => {
    for (const key of ["signature", "body"]) {
      const symbol = { ...snap.symbols[0], [key]: "function slugify() {}" };
      expect(MainSnapshotSchema.safeParse({ ...snap, symbols: [symbol] }).success).toBe(false);
    }
    expect(MainSnapshotSchema.safeParse({ ...snap, body: "x" }).success).toBe(false);
  });

  it("CloseRequest needs head_sha when merged", () => {
    expect(CloseRequestSchema.safeParse({ merged: false }).success).toBe(true);
    expect(CloseRequestSchema.safeParse({ merged: true }).success).toBe(false);
    expect(CloseRequestSchema.safeParse({ merged: false, head_sha: SHA }).success).toBe(true);
  });

  it("ChangeSet checks that the id names the repo and the pull request number", () => {
    expect(ChangeSetSchema.safeParse({ ...changeSet(), pr: 2 }).success).toBe(false);
    expect(ChangeSetSchema.safeParse({ ...changeSet(), repo: "other/repo" }).success).toBe(false);
    const branch = {
      ...changeSet(),
      id: `cs:branch:${REPO}:feat/x`,
      source: "branch" as const,
      ref: "feat/x",
      head_ref: "feat/x",
    };
    const { pr: _pr, ...noPr } = branch;
    expect(ChangeSetSchema.safeParse(noPr).success).toBe(true);
    expect(ChangeSetSchema.safeParse({ ...noPr, source: "pr" }).success).toBe(false);
  });
});

describe("part records", () => {
  it("accepts each tag with its keys and rejects an extra key or an unknown tag", () => {
    const records = [
      { t: "w", ...snap.workspaces[0] },
      { t: "f", ...snap.files[0] },
      { t: "s", ...snap.symbols[0] },
      { t: "e", ...snap.edges[0] },
      { t: "a", ...snap.adapter_nodes[0] },
    ];
    for (const r of records) {
      expect(MainRecordSchema.safeParse(r).success).toBe(true);
      expect(PartRecordSchema.safeParse(r).success).toBe(true);
      expect(PartRecordSchema.safeParse({ ...r, extra: 1 }).success).toBe(false);
    }
    const { nodes: _n, radius: _r, repo: _p, ...header } = changeSet();
    const csRecords = [
      { t: "c", ...header },
      { t: "n", id: ids.FILE },
      { t: "r", ...changeSet().radius[0] },
    ];
    for (const r of csRecords) {
      expect(ChangeSetRecordSchema.safeParse(r).success).toBe(true);
      expect(PartRecordSchema.safeParse({ ...r, extra: 1 }).success).toBe(false);
    }
    expect(PartRecordSchema.safeParse({ t: "x", id: "a" }).success).toBe(false);
    expect(PartRecordSchema.safeParse({ t: "n", id: "a", repo: REPO }).success).toBe(false);
    // the c record has no repo: the path names it
    expect(PartRecordSchema.safeParse({ t: "c", ...header, repo: REPO }).success).toBe(false);
  });
});

describe("response schemas are tolerant", () => {
  const cases: [string, z.ZodType, Record<string, unknown>][] = [
    [
      "UploadBegun",
      UploadBegunSchema,
      {
        upload_id: "5f3a9c1e7b2d4a60918c3e7d",
        part_max_records: 2000,
        part_max_bytes: 1048576,
        max_parts: 1000,
      },
    ],
    ["UploadPartResponse", UploadPartResponseSchema, { upload_id: "a", part: 1, status: "queued" }],
    [
      "UploadStatus",
      UploadStatusSchema,
      { status: "loading", parts: { total: 1, received: 1, done: 0, failed: 0 } },
    ],
    ["CloseResponse", CloseResponseSchema, { closed: true }],
    ["DescriptionsResponse", DescriptionsResponseSchema, { stored: 1 }],
    ["SavedResponse", SavedResponseSchema, { saved: true }],
    ["DeletedResponse", DeletedResponseSchema, { deleted: false }],
    [
      "WhoamiResponse",
      WhoamiResponseSchema,
      { kind: "ci", org: "acme", repo: REPO, repo_connected: true, protocol: 1 },
    ],
    ["Error", ErrorSchema, { error: "budget", message: "the daily upload capacity is used; try later" }],
    ["ChangeSetRead", ChangeSetReadSchema, changeSet() as unknown as Record<string, unknown>],
    [
      "PullResponse",
      PullResponseSchema,
      {
        change_sets: [changeSet()],
        team_views: [view],
        groups: [group],
        settings: {},
        pulled_at: "2026-11-20T09:41:00.000Z",
      },
    ],
  ];
  for (const [name, schema, valid] of cases) {
    it(`${name} drops an unknown key`, () => {
      const parsed = schema.parse({ ...valid, extra: 1 }) as Record<string, unknown>;
      expect("extra" in parsed).toBe(false);
      expect(parsed).toMatchObject(valid);
    });
  }

  it("a pull drops unknown keys of its nested change sets, views and groups", () => {
    const parsed = PullResponseSchema.parse({
      change_sets: [{ ...changeSet(), extra: 1, radius: [{ ...changeSet().radius[0], extra: 1 }] }],
      team_views: [{ ...view, extra: 1, spec: { ...view.spec, extra: 1 } }],
      groups: [{ ...group, extra: 1 }],
      settings: { extra: 1 },
      pulled_at: "x",
    });
    expect(JSON.stringify(parsed)).not.toContain("extra");
  });

  it("ErrorSchema knows the eight codes", () => {
    for (const error of [
      "unauthorized",
      "forbidden",
      "not_found",
      "invalid",
      "too_large",
      "conflict",
      "budget",
      "protocol_version",
    ]) {
      expect(ErrorSchema.safeParse({ error, message: "m" }).success).toBe(true);
    }
    expect(ErrorSchema.safeParse({ error: "teapot", message: "m" }).success).toBe(false);
  });
});

describe("limits", () => {
  const many = <T>(item: T, n: number): T[] => Array.from({ length: n }, () => item);

  it("enforces the description limits", () => {
    const ok = (patch: object): boolean =>
      DescriptionSchema.safeParse({ ...description(), ...patch }).success;
    expect(ok({})).toBe(true);
    expect(ok({ behavior: "x".repeat(400) })).toBe(true);
    expect(ok({ behavior: "x".repeat(401) })).toBe(false);
    expect(ok({ search_terms: [] })).toBe(false);
    expect(ok({ search_terms: many("a", 6) })).toBe(true);
    expect(ok({ search_terms: many("a", 7) })).toBe(false);
    expect(ok({ search_terms: ["x".repeat(61)] })).toBe(false);
    expect(ok({ search_terms: [""] })).toBe(false);
    expect(ok({ suggested_name: "slugifyTitle" })).toBe(true);
    expect(ok({ suggested_name: "1bad" })).toBe(false);
    expect(ok({ suggested_name: "a".repeat(81) })).toBe(false);
    expect(ok({ content_key: "abc:p1" })).toBe(false);
    expect(ok({ content_key: `${ids.HASH}:px` })).toBe(false);
    expect(ok({ prompt_version: "1" })).toBe(false);
    expect(ok({ model: null })).toBe(true);
    expect(ok({ model: "m".repeat(101) })).toBe(false);
    expect(ok({ provenance: "other" })).toBe(false);
  });

  it("enforces 500 descriptions per call", () => {
    const req = (n: number) => ({ repo: REPO, descriptions: many(description(), n) });
    expect(DescriptionsRequestSchema.safeParse(req(LIMITS.descriptions)).success).toBe(true);
    expect(DescriptionsRequestSchema.safeParse(req(LIMITS.descriptions + 1)).success).toBe(false);
  });

  it("enforces the array limits of a change set", () => {
    const cs = changeSet();
    const entry = cs.radius[0] as (typeof cs.radius)[number];
    expect(ChangeSetSchema.safeParse({ ...cs, nodes: many("n", LIMITS.nodes) }).success).toBe(true);
    expect(ChangeSetSchema.safeParse({ ...cs, nodes: many("n", LIMITS.nodes + 1) }).success).toBe(false);
    expect(ChangeSetSchema.safeParse({ ...cs, radius: many(entry, LIMITS.radius) }).success).toBe(true);
    expect(ChangeSetSchema.safeParse({ ...cs, radius: many(entry, LIMITS.radius + 1) }).success).toBe(false);
    expect(ChangeSetSchema.safeParse({ ...cs, links: many("TICKET-1", LIMITS.links) }).success).toBe(true);
    expect(ChangeSetSchema.safeParse({ ...cs, links: many("TICKET-1", LIMITS.links + 1) }).success).toBe(
      false,
    );
    expect(ChangeSetSchema.safeParse({ ...cs, links: ["x".repeat(301)] }).success).toBe(false);
  });

  it("enforces the array limits of a snapshot", () => {
    const check = (key: keyof typeof snap, limit: number): void => {
      const item = (snap[key] as unknown[])[0];
      expect(MainSnapshotSchema.safeParse({ ...snap, [key]: many(item, limit) }).success).toBe(true);
      expect(MainSnapshotSchema.safeParse({ ...snap, [key]: many(item, limit + 1) }).success).toBe(false);
    };
    check("workspaces", LIMITS.workspaces);
    check("files", LIMITS.files);
    check("adapter_nodes", LIMITS.adapter_nodes);
    check("symbols", LIMITS.symbols);
    check("edges", LIMITS.edges);
  });

  it("enforces the count limits at begin", () => {
    const counts = { workspaces: 1, files: 1, symbols: 1, edges: LIMITS.edges, adapter_nodes: 1 };
    expect(UploadStartSchema.safeParse({ kind: "main", sha: SHA, counts }).success).toBe(true);
    expect(
      UploadStartSchema.safeParse({ kind: "main", sha: SHA, counts: { ...counts, edges: LIMITS.edges + 1 } })
        .success,
    ).toBe(false);
    expect(
      UploadStartSchema.safeParse({ kind: "change_set", counts: { nodes: 0, radius: LIMITS.radius + 1 } })
        .success,
    ).toBe(false);
  });

  it("enforces string rules", () => {
    const sym = snap.symbols[0];
    expect(SymbolSchema.safeParse({ ...sym, lang: "Type Script" }).success).toBe(false);
    expect(SymbolSchema.safeParse({ ...sym, kind: "Function" }).success).toBe(false);
    expect(SymbolSchema.safeParse({ ...sym, renamed_hash: null, content_key: null }).success).toBe(true);
    expect(SymbolSchema.safeParse({ ...sym, exact_hash: "ABC" }).success).toBe(false);
    expect(AdapterNodeSchema.safeParse({ ...snap.adapter_nodes[0], label: "a\nb" }).success).toBe(false);
    expect(AdapterNodeSchema.safeParse({ ...snap.adapter_nodes[0], label: "x".repeat(201) }).success).toBe(
      false,
    );
    expect(AdapterNodeSchema.safeParse({ ...snap.adapter_nodes[0], file_id: null }).success).toBe(true);
    expect(ChangeSetSchema.safeParse({ ...changeSet(), head_sha: "abc" }).success).toBe(false);
    expect(ChangeSetSchema.safeParse({ ...changeSet(), created_at: "yesterday" }).success).toBe(false);
    expect(ChangeSetSchema.safeParse({ ...changeSet(), head_ref: "" }).success).toBe(true);
    expect(ChangeSetSchema.safeParse({ ...changeSet(), confidence: 1.5 }).success).toBe(false);
  });
});

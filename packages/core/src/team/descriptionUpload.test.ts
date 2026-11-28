import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { type Description, DescriptionSchema, UploadRefused } from "@gantry/protocol";
import { type FakeServer, startFakeServer } from "@gantry/protocol/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GantryConfig } from "../config/index.js";
import type { GantryPaths } from "../paths/index.js";
import { openStore, type Store } from "../store/index.js";
import { resetTeamProtocolCache, teamClient } from "./client.js";
import { descriptionRecords, uploadDescriptions } from "./descriptionUpload.js";

const USER_TOKEN = "tok-user-52ab";
const REPO = "acme/storefront";
const paths = { repo: REPO } as GantryPaths;
const configFor = (server: string): GantryConfig =>
  ({
    team: { server, org: "acme", upload: { descriptions: true, working: false } },
  }) as unknown as GantryConfig;

let fake: FakeServer;
let tmp: string;
let store: Store;

beforeEach(async () => {
  resetTeamProtocolCache();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-desc-upload-"));
  store = openStore(path.join(tmp, "index.db"));
  fake = await startFakeServer({ tokens: [USER_TOKEN] });
});
afterEach(async () => {
  store.close();
  await fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const key = (n: number): string => `${n.toString(16).padStart(32, "0")}:p1`;

interface Seed {
  n: number;
  provenance?: string;
  model?: string | null;
  suggested?: string | null;
  nameFits?: number;
}

function seed(...rows: Seed[]): void {
  const insert = store.db.prepare(
    `INSERT INTO descriptions(content_key, behavior, search_terms, name_fits, suggested_name, provenance, model,
       prompt_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  store.tx(() => {
    for (const r of rows) {
      insert.run(
        key(r.n),
        `Does thing ${r.n}.`,
        JSON.stringify(["alpha", `term${r.n}`]),
        r.nameFits ?? 1,
        r.suggested === undefined ? null : r.suggested,
        r.provenance ?? "model",
        r.model === undefined ? "haiku" : r.model,
        "p1",
        `2026-03-04T05:06:07.${String(r.n % 1000).padStart(3, "0")}Z`,
      );
    }
  });
}

const client = (fetchFn?: typeof fetch) =>
  teamClient(paths, configFor(fake.url), {
    env: { GANTRY_CREDENTIALS_FILE: path.join(tmp, "credentials.json") },
    server: fake.url,
    org: "acme",
    token: USER_TOKEN,
    ...(fetchFn === undefined ? {} : { fetch: fetchFn }),
  });

describe("uploadDescriptions", () => {
  it("sends the model rows only: not a fallback row, not a row with no model", async () => {
    seed(
      { n: 1 },
      { n: 2, suggested: "betterName", nameFits: 0 },
      { n: 3 },
      { n: 4, provenance: "fallback", model: null },
      { n: 5, model: null },
      { n: 6, provenance: "template", model: null },
    );
    const result = await uploadDescriptions(store, client(), REPO, { enabled: true });
    expect(result).toEqual({ sent: 3, stored: 3, skipped: 0 });
    expect([...fake.state.descriptions.keys()].sort()).toEqual([key(1), key(2), key(3)]);
  });

  it("maps a row field for field: search_terms an array, name_fits a boolean, suggested_name omitted when null", () => {
    seed({ n: 7, suggested: "parseSlug", nameFits: 0 }, { n: 8 });
    const { records } = descriptionRecords(store);
    expect(records[0]).toEqual({
      content_key: key(7),
      behavior: "Does thing 7.",
      search_terms: ["alpha", "term7"],
      name_fits: false,
      suggested_name: "parseSlug",
      provenance: "model",
      model: "haiku",
      prompt_version: "p1",
      created_at: "2026-03-04T05:06:07.007Z",
    });
    expect(records[1]).toEqual({
      content_key: key(8),
      behavior: "Does thing 8.",
      search_terms: ["alpha", "term8"],
      name_fits: true,
      provenance: "model",
      model: "haiku",
      prompt_version: "p1",
      created_at: "2026-03-04T05:06:07.008Z",
    });
    expect("suggested_name" in (records[1] as object)).toBe(false);
  });

  it("makes three requests for 1,201 rows, in content_key order, and sums `stored`", async () => {
    seed(...Array.from({ length: 1201 }, (_, i) => ({ n: i + 1 })));
    const sent: Description[][] = [];
    const recorder: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/v1/descriptions") && typeof init?.body === "string") {
        sent.push((JSON.parse(init.body) as { descriptions: Description[] }).descriptions);
      }
      return fetch(input, init);
    };
    const result = await uploadDescriptions(store, client(recorder), REPO, { enabled: true });
    expect(result).toEqual({ sent: 1201, stored: 1201, skipped: 0 });
    expect(sent.map((b) => b.length)).toEqual([500, 500, 201]);
    const keys = sent.flat().map((d) => d.content_key);
    expect(keys).toEqual([...keys].sort());
    expect(fake.state.descriptions.size).toBe(1201);
    // a second run stores nothing new
    expect(await uploadDescriptions(store, client(), REPO, { enabled: true })).toMatchObject({
      sent: 1201,
      stored: 0,
    });
  });

  it("leaves every stored record equal to the mapped local row in all nine fields", async () => {
    seed({ n: 10, suggested: "slugify" }, { n: 11, nameFits: 0 }, { n: 12 });
    const expected = descriptionRecords(store).records;
    await uploadDescriptions(store, client(), REPO, { enabled: true });
    expect(expected).toHaveLength(3);
    for (const want of expected) {
      const got = fake.state.descriptions.get(want.content_key);
      expect(got).toEqual(want);
      expect(Object.keys(got as object).sort()).toEqual(Object.keys(want).sort());
    }
    expect(fake.state.descriptions.get(key(10))?.suggested_name).toBe("slugify");
  });

  it("does not send a row the wire format would refuse, and counts it", async () => {
    seed({ n: 20 }, { n: 21 });
    store.db.prepare("UPDATE descriptions SET search_terms = ? WHERE content_key = ?").run("[]", key(21));
    expect(await uploadDescriptions(store, client(), REPO, { enabled: true })).toEqual({
      sent: 1,
      stored: 1,
      skipped: 1,
    });
  });

  it("makes no request when there is nothing to send", async () => {
    seed({ n: 30, provenance: "fallback", model: null });
    let requests = 0;
    const counting: typeof fetch = async (input, init) => {
      requests += 1;
      return fetch(input, init);
    };
    expect(await uploadDescriptions(store, client(counting), REPO, { enabled: true })).toEqual({
      sent: 0,
      stored: 0,
      skipped: 0,
    });
    expect(requests).toBe(0);
  });

  it("with the switch off throws before it reads the table or makes a request", async () => {
    let requests = 0;
    const counting: typeof fetch = async (input, init) => {
      requests += 1;
      return fetch(input, init);
    };
    await expect(uploadDescriptions(store, client(counting), REPO, { enabled: false })).rejects.toThrow(
      "Description upload is switched off (team.upload.descriptions).",
    );
    expect(requests).toBe(0);
  });
});

describe("the guard inside the upload functions", () => {
  const counting = (): { fetchFn: typeof fetch; requests: string[] } => {
    const requests: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      requests.push(String(input));
      return fetch(input, init);
    };
    return { fetchFn, requests };
  };
  const SHA = "1863607d4346a2737224baab89b421b2b1a1b8bf";

  it("uploadDescriptions with no serializer refuses a record that carries a forbidden key, before any request", async () => {
    seed({ n: 1 });
    const real = DescriptionSchema.safeParse.bind(DescriptionSchema);
    const spy = vi.spyOn(DescriptionSchema, "safeParse").mockImplementation((value) => {
      const parsed = real(value);
      return parsed.success ? { ...parsed, data: { ...parsed.data, text: "export const a = 1;" } } : parsed;
    });
    try {
      const { fetchFn, requests } = counting();
      await expect(uploadDescriptions(store, client(fetchFn), REPO, { enabled: true })).rejects.toThrow(
        UploadRefused,
      );
      expect(requests).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("the client methods refuse a forbidden key before any request, the handshake included", async () => {
    const { fetchFn, requests } = counting();
    const c = client(fetchFn);
    const start = {
      kind: "main",
      sha: SHA,
      counts: { workspaces: 0, files: 0, symbols: 0, edges: 0, adapter_nodes: 0 },
    };
    const close = { merged: false };
    const batch = { repo: REPO, descriptions: [] };
    for (const key of ["signature", "body", "fact_sheet"]) {
      await expect(c.beginUpload(REPO, { ...start, [key]: "x" }, "main")).rejects.toThrow(UploadRefused);
      await expect(c.beginUpload(REPO, JSON.stringify({ ...start, [key]: "x" }), "main")).rejects.toThrow(
        UploadRefused,
      );
      await expect(
        c.closeChangeSet(REPO, "cs:pr:acme/storefront#1", { ...close, [key]: "x" }),
      ).rejects.toThrow(UploadRefused);
      await expect(c.putDescriptions({ ...batch, [key]: "x" })).rejects.toThrow(UploadRefused);
      const record = { t: "w", id: "ws:a:.", name: "a", path: ".", [key]: "x" };
      const part = new Uint8Array(
        gzipSync(
          `${JSON.stringify({ t: "w", id: "ws:a:b", name: "b", path: "b" })}\n${JSON.stringify(record)}\n`,
        ),
      );
      await expect(c.putPart("up_1", 1, part, 1)).rejects.toThrow(UploadRefused);
    }
    await expect(c.putPart("up_1", 1, new Uint8Array([1, 2, 3]), 1)).rejects.toThrow(UploadRefused);
    expect(requests).toEqual([]);
  });

  it("refuses a body and a part line with a repeated key, which JSON.parse would hide, before any request", async () => {
    const { fetchFn, requests } = counting();
    const c = client(fetchFn);
    const hidden = `{"merged":false,"merged":false,"signature":"x"}`;
    // the repeated key is dropped by JSON.parse, so a guard that only looked at the parsed value would pass this
    const dup = `{"merged":false,"head_sha":"${SHA}","head_sha":"${SHA}"}`;
    await expect(c.closeChangeSet(REPO, "cs:pr:acme/storefront#1", dup)).rejects.toThrow(UploadRefused);
    await expect(c.closeChangeSet(REPO, "cs:pr:acme/storefront#1", hidden)).rejects.toThrow(UploadRefused);
    await expect(c.putDescriptions(`{"repo":"${REPO}","descriptions":[],"repo":"${REPO}"}`)).rejects.toThrow(
      UploadRefused,
    );
    const line = `{"t":"w","id":"ws:a:.","name":"a","name":"b","path":"."}`;
    const part = new Uint8Array(gzipSync(`${line}\n`));
    await expect(c.putPart("up_1", 1, part, 1)).rejects.toThrow(UploadRefused);
    expect(requests).toEqual([]);
  });

  it("a clean body still goes through every guarded method", async () => {
    const { fetchFn, requests } = counting();
    const c = client(fetchFn);
    await c.putDescriptions({ repo: REPO, descriptions: [] });
    expect(requests.some((r) => r.includes("/v1/descriptions"))).toBe(true);
  });
});

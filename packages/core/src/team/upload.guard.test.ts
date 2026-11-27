import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexRepo } from "../indexer.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { openStore, type Store } from "../store/index.js";
import { buildChangeSet, buildMainSnapshot, changeSetRecords, snapshotRecords } from "./upload.js";

// The guard for what leaves the machine. It reads both payloads of two fixtures as plain data and fails when any
// field could carry source: a forbidden key, a multi-line value, a line of the fixture's own code, or a signature.

interface UploadFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../test/helpers/upload-fixture.js";
const { materializeUploadFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeUploadFixture: (
    name: string,
    opts: {
      dirName: string;
      origin?: string;
      branch?: string;
      edit?: { file: string; from: string; to: string };
    },
  ) => Promise<UploadFixture>;
};

const FORBIDDEN_KEYS = new Set([
  "signature",
  "body",
  "text",
  "code",
  "snippet",
  "doc",
  "content",
  "contents",
  "fact_sheet",
  "factSheet",
]);
const LONG_LINE = 40;

interface Evidence {
  /** Trimmed lines of the fixture's source files that are longer than 40 characters. */
  sourceLines: string[];
  /** Every non-empty signature the store holds (functions, types, interfaces, classes, constants). */
  signatures: string[];
  /** The raw labels of adapter nodes that hold a line break or control character, as the store has them. */
  rawLabels: string[];
}

/** Every problem found in `payload`; an empty list means the payload carries no source. */
function findLeaks(payload: unknown, evidence: Evidence): string[] {
  const problems: string[] = [];
  // A short signature is matched as a whole field value; a long one anywhere in the text (below).
  const shortSignatures = new Set(evidence.signatures.filter((x) => x.length <= LONG_LINE));
  const walk = (value: unknown, at: string): void => {
    if (typeof value === "string") {
      if (/[\r\n]/.test(value)) problems.push(`${at}: a string value holds a newline`);
      if (shortSignatures.has(value)) problems.push(`${at}: a string value is a whole signature`);
      for (const line of evidence.sourceLines) {
        if (value.includes(line)) problems.push(`${at}: a string value holds a line of the source`);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const [i, v] of value.entries()) walk(v, `${at}[${i}]`);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(k)) problems.push(`${at}.${k}: a key that can carry source`);
        if (k === "source" && v !== "pr" && v !== "branch") problems.push(`${at}.source: not pr or branch`);
        walk(v, `${at}.${k}`);
      }
    }
  };
  walk(payload, "$");
  const text = JSON.stringify(payload);
  for (const sig of evidence.signatures) {
    if (text.includes(JSON.stringify(sig).slice(1, -1)))
      problems.push(`a signature occurs in the payload: ${sig}`);
  }
  for (const label of evidence.rawLabels) {
    const collapsed = label.replace(/\s+/g, " ").trim();
    if (text.includes(JSON.stringify(collapsed).slice(1, -1))) {
      problems.push("a multi-line adapter label occurs in the payload");
    }
    for (const line of label.split(/\r?\n/)) {
      if (line.trim().length > 8 && text.includes(JSON.stringify(line.trim()).slice(1, -1))) {
        problems.push("a line of a multi-line adapter label occurs in the payload");
      }
    }
  }
  return problems;
}

interface Case {
  name: string;
  fixture: string;
  dirName: string;
  edit: { file: string; from: string; to: string };
  /** The symbol whose signature the guard names explicitly. */
  symbol: string;
}
const cases: Case[] = [
  {
    name: "pnpm-turbo",
    fixture: "pnpm-turbo",
    dirName: "pnpm-turbo",
    edit: {
      file: "packages/utils/src/slug.ts",
      from: 'dashed.replace(/[^a-z0-9-]/g, "")',
      to: 'dashed.replace(/[^a-z0-9_-]/g, "")',
    },
    symbol: "sym:fixture/pnpm-turbo:packages/utils/src/slug.ts#slugify",
  },
  {
    name: "go-basic",
    fixture: "go-basic",
    dirName: "go-basic",
    edit: { file: "internal/text/slug.go", from: "b.WriteByte('-')", to: "b.WriteByte('_')" },
    symbol: "sym:fixture/go-basic:internal/text/slug.go#Slugify",
  },
];

describe.each(cases)("the upload payloads of $name carry no source", (c) => {
  let fx: UploadFixture;
  let data: string;
  let paths: GantryPaths;
  let store: Store;
  let evidence: Evidence;
  let payloads: Record<string, unknown>;

  beforeAll(async () => {
    fx = await materializeUploadFixture(c.fixture, {
      dirName: c.dirName,
      origin: `https://github.com/fixture/${c.dirName}.git`,
      branch: "feat/edit",
      edit: c.edit,
    });
    data = mkdtempSync(join(tmpdir(), "gantry-data-"));
    paths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
    await indexRepo(paths, { layer: "main" });
    store = openStore(paths.dbPath);

    const lines = new Set<string>();
    for (const f of store.effectiveFiles()) {
      let text: string;
      try {
        text = readFileSync(join(paths.root, f.path), "utf8");
      } catch {
        continue;
      }
      for (const l of text.split(/\r?\n/)) if (l.trim().length > LONG_LINE) lines.add(l.trim());
    }
    const symbols = store.effectiveSymbols();
    const signatures = new Set(symbols.filter((s) => s.signature.length > 0).map((s) => s.signature));
    const rawLabels = store
      .effectiveAdapterNodes()
      .map((n) => n.label)
      .filter((l) => /[\r\n]/.test(l));
    evidence = { sourceLines: [...lines], signatures: [...signatures], rawLabels };

    const snapshot = buildMainSnapshot(store, paths);
    const { changeSet } = await buildChangeSet(store, paths, {
      base: "main",
      head: "feat/edit",
      pr: 1,
      owner: "fixture-dev",
      head_ref: "feat/edit",
      base_branch: "main",
      title: "An edit",
      now: "2026-01-02T03:04:05.000Z",
    });
    payloads = {
      snapshot,
      changeSet,
      snapshotRecords: snapshotRecords(snapshot),
      changeSetRecords: changeSetRecords(changeSet),
    };
  });
  afterAll(async () => {
    store.close();
    rmSync(data, { recursive: true, force: true });
    await fx.cleanup();
  });

  it("has source lines and signatures to look for", () => {
    expect(evidence.sourceLines.length).toBeGreaterThan(0);
    expect(evidence.signatures.length).toBeGreaterThan(0);
    const sym = store.effectiveSymbols().find((s) => s.id === c.symbol);
    expect(sym?.signature, `the store has ${c.symbol}`).toBeTruthy();
    expect(evidence.signatures).toContain(sym?.signature);
  });

  it("passes the guard: no forbidden key, no multi-line value, no line of source, no signature", () => {
    for (const [name, payload] of Object.entries(payloads)) {
      expect(findLeaks(payload, evidence), name).toEqual([]);
    }
  });

  it("never holds the signature of the named symbol", () => {
    const sig = store.effectiveSymbols().find((s) => s.id === c.symbol)?.signature as string;
    for (const payload of Object.values(payloads)) expect(JSON.stringify(payload)).not.toContain(sig);
  });

  it("is byte-stable across runs", async () => {
    const again = await buildChangeSet(store, paths, {
      base: "main",
      head: "feat/edit",
      pr: 1,
      owner: "fixture-dev",
      head_ref: "feat/edit",
      base_branch: "main",
      title: "An edit",
      now: "2026-01-02T03:04:05.000Z",
    });
    expect(JSON.stringify(again.changeSet)).toBe(JSON.stringify(payloads.changeSet));
    expect(JSON.stringify(buildMainSnapshot(store, paths))).toBe(JSON.stringify(payloads.snapshot));
  });

  describe("the scratch injections", () => {
    const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
    const snapshot = () =>
      clone(payloads.snapshot) as { symbols: Record<string, unknown>[]; files: Record<string, unknown>[] };
    const sigOf = () => store.effectiveSymbols().find((s) => s.id === c.symbol)?.signature as string;

    it("fails when a symbol gains a signature field", () => {
      const s = snapshot();
      (s.symbols[0] as Record<string, unknown>).signature = "x";
      expect(findLeaks(s, evidence)).not.toEqual([]);
    });
    it.each(["body", "text", "code", "snippet", "doc", "content", "contents", "fact_sheet", "factSheet"])(
      "fails when a file gains a %s field",
      (key) => {
        const s = snapshot();
        (s.files[0] as Record<string, unknown>)[key] = "x";
        expect(findLeaks(s, evidence)).not.toEqual([]);
      },
    );
    it("fails when a source field holds anything but pr or branch", () => {
      const cs = clone(payloads.changeSet) as Record<string, unknown>;
      cs.source = "return a + b;";
      expect(findLeaks(cs, evidence)).not.toEqual([]);
    });
    it("fails when a string value holds a newline", () => {
      const s = snapshot();
      s.files[0] = { ...s.files[0], path: "a\nb" };
      expect(findLeaks(s, evidence)).not.toEqual([]);
    });
    it("fails when a string value holds a long line of the source", () => {
      const s = snapshot();
      s.files[0] = { ...s.files[0], path: evidence.sourceLines[0] };
      expect(findLeaks(s, evidence)).not.toEqual([]);
    });
    it("fails when a short signature of a constant is a whole field value", () => {
      // The fixtures index no signature for a constant, so the evidence gets one, as a language pack could give it.
      const konst = "export const SLUG_LIMIT = 80";
      expect(konst.length <= LONG_LINE).toBe(true);
      const withConst = { ...evidence, signatures: [...evidence.signatures, konst] };
      const s = snapshot();
      s.symbols[0] = { ...s.symbols[0], name: konst };
      expect(findLeaks(s, withConst)).not.toEqual([]);
      expect(findLeaks(snapshot(), withConst)).toEqual([]);
    });
    it("fails when a multi-line adapter label is flattened into one line", () => {
      const raw = "route(`\n  return secretCode(1);\n`)";
      const withLabel = { ...evidence, rawLabels: [raw] };
      const flat = { adapter_nodes: [{ id: "route:x", label: "route(` return secretCode(1); `)" }] };
      expect(findLeaks(flat, withLabel)).not.toEqual([]);
      expect(findLeaks({ adapter_nodes: [{ id: "route:x", label: "" }] }, withLabel)).toEqual([]);
    });
    it("fails when the signature of a function occurs in a value", () => {
      const s = snapshot();
      s.symbols[0] = { ...s.symbols[0], name: sigOf() };
      expect(findLeaks(s, evidence)).not.toEqual([]);
    });
  });
});

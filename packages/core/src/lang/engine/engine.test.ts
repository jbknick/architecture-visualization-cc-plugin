import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { dumpGraph, indexRepo } from "../../indexer.js";
import { type GantryPaths, resolvePaths } from "../../paths/index.js";
import { openStore } from "../../store/index.js";
import { LANG_IDS, languageModule, languageOfPath, languages } from "../index.js";
import { PACKS } from "../packs/index.js";

const helperPath = "../../../test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<{ dir: string; cleanup(): Promise<void> }>;
};

const strings = z.array(z.string().min(1));
const regexp = z.instanceof(RegExp);
const field = z.string().min(1);
const declaration = z.object({
  kind: field,
  name: field,
  parameters: field,
  result: field,
  body: field.optional(),
  receiver: field.optional(),
});
const specGroup = { declarations: strings, specs: strings, groups: strings };
const from = z.enum(["start", "end"]);

const TypingSchema = z.strictObject({
  type: z.strictObject({
    names: strings,
    qualified: z.strictObject({ kind: field, qualifier: field, name: field }),
    wrappers: strings,
    generic: z.strictObject({ kind: field, field }),
    sequences: z.array(z.strictObject({ kind: field, element: field })),
    maps: z.strictObject({ kind: field, key: field, value: field }),
    predeclared: strings,
  }),
  package: z.strictObject({ clause: field, separate: field }),
  unboundAliases: strings,
  results: z.strictObject({ list: field, name: field, nameKinds: strings, type: field }),
  members: z.strictObject({
    container: field,
    entries: strings,
    name: field,
    nameKinds: strings,
    type: field,
  }),
  interfaces: z.strictObject({ embeds: strings, embedKinds: strings }),
  generics: field,
  vars: z.strictObject({ declarations: strings, specs: strings, type: field, value: field }),
  unnamed: strings,
  callee: z.strictObject({
    names: strings,
    members: z.array(z.strictObject({ kind: field, operand: field, name: field })),
    operands: strings,
  }),
  conversion: z.strictObject({ kind: field, type: field }),
  builtins: z.strictObject({ arguments: field, typed: strings, first: strings }),
  expressions: z.strictObject({
    wrappers: strings,
    names: strings,
    index: z.strictObject({ kind: field, operand: field }),
    through: z.array(
      z.strictObject({
        kind: field,
        operand: field,
        operator: z.strictObject({ field, values: strings }).optional(),
      }),
    ),
    typed: z.array(z.strictObject({ kind: field, type: field })),
  }),
  locals: z.strictObject({
    nameKinds: strings,
    parameters: z.array(
      z.strictObject({ kind: field, name: field, type: field, variadic: z.boolean(), from }),
    ),
    declarations: z.array(
      z.strictObject({ kind: field, names: field, type: field.optional(), values: field, from }),
    ),
    ranges: z.array(z.strictObject({ kind: field, names: field, source: field, from })),
    untyped: z.array(z.strictObject({ kind: field, names: field, from })),
  }),
  lookups: strings,
});

const PackSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: field,
  extensions: z.array(z.string().regex(/^\.[a-z0-9]+$/)).min(1),
  skipPaths: strings,
  testPatterns: strings,
  generatedPatterns: z.array(regexp),
  grammar: z.strictObject({ package: field, name: field }),
  nodes: z.strictObject({
    errorKind: field,
    function: z.array(declaration),
    method: z.array(declaration),
    receiver: z.strictObject({
      parameter: field,
      type: field,
      baseType: z.strictObject({
        names: strings,
        wrappers: strings,
        generic: z.strictObject({ kind: field, field }),
        unknown: field,
      }),
    }),
    types: z.strictObject({
      declarations: strings,
      specs: strings,
      groups: strings,
      aliases: strings,
      name: field,
      type: field,
      class: strings,
      interface: strings,
      interfaceMethods: z.strictObject({
        container: field,
        members: strings,
        rule: z.strictObject({ name: field, parameters: field, result: field }),
      }),
    }),
    values: z.strictObject({ ...specGroup, name: field, nameKinds: strings }),
    import: z.strictObject({
      ...specGroup,
      path: field,
      alias: field,
      quotes: z.string(),
      separator: field,
      localName: z.strictObject({ skip: regexp }),
    }),
    call: strings,
    callee: z.strictObject({
      field,
      names: strings,
      member: z.strictObject({ kind: field, operand: field, name: field, operands: strings }),
    }),
    typing: TypingSchema.optional(),
    exported: z.literal("capitalized"),
    signature: z.strictObject({ empty: z.string(), maxLength: z.number().int().positive() }),
    measure: z.strictObject({
      branches: strings,
      binary: z.strictObject({ kind: field, operator: field, operators: strings }),
      statements: strings,
    }),
  }),
  workspace: z.strictObject({
    manifest: field,
    quotes: z.string(),
    comment: regexp,
    name: regexp,
    skipDirs: strings,
    deps: z.strictObject({ directive: field, tokens: z.number().int().positive() }),
    main: regexp,
    group: z.strictObject({ file: field, directive: field, tokens: z.number().int().positive() }),
  }),
  tokens: z.strictObject({
    identifiers: strings,
    local: field,
    strings,
    numbers: strings,
    comments: strings,
    punctuation: strings,
    ownName: field,
    locals: z.strictObject({
      parameters: z.strictObject({ kinds: strings, field }),
      bindings: z.array(z.strictObject({ kind: field, field })),
      specs: z.strictObject({ kinds: strings, field }),
      blank: field,
    }),
    embedding: z.strictObject({ strings, stringText: field, localPrefix: field }),
  }),
  kindLabels: z.strictObject({
    function: field,
    method: field,
    component: field,
    hook: field,
    class: field,
    type: field,
    interface: field,
    enum: field,
    const: field,
  }),
  factSheetHints: z.array(z.string()),
  thresholds: z.strictObject({
    exactMinStmts: z.number().int().positive(),
    nearMinStmts: z.number().int().positive(),
  }),
});

describe("language packs", () => {
  it.each(PACKS.map((p) => [p.id, p] as const))("the %s pack has the pack shape", (_id, pack) => {
    expect(PackSchema.parse(pack)).toBeTruthy();
  });

  it.each(PACKS.map((p) => [p.id, p] as const))(
    "the %s pack is claimed by its extensions and has a module",
    (_id, pack) => {
      expect(languageModule(pack.id).id).toBe(pack.id);
      expect(languages().map((m) => m.id)).toEqual(["typescript", ...PACKS.map((p) => p.id)]);
      for (const ext of pack.extensions) expect(languageOfPath(`a/b${ext}`)?.id).toBe(pack.id);
    },
  );

  it("derives the language ids from the packs plus TypeScript", () => {
    expect(LANG_IDS).toEqual(["typescript", ...PACKS.map((p) => p.id)]);
    for (const p of PACKS) expect(languageModule(p.id).label).toBe(p.label);
  });
});

describe("engine", () => {
  it("names no language", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain(join("resolve", "calls.ts"));
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      for (const p of PACKS) {
        expect(text, `${f} names ${p.id}`).not.toMatch(new RegExp(`["'\`]${p.id}["'\`]|\\b${p.label}\\b`));
      }
    }
  });
});

const dataDirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of dataDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const c of cleanups.splice(0)) await c();
});

describe("Go index determinism", () => {
  it("dumps byte-equal output from two fresh data dirs", async () => {
    const fx = await materializeFixture("go-basic");
    cleanups.push(fx.cleanup);
    const dumps: string[] = [];
    for (let i = 0; i < 2; i++) {
      const data = mkdtempSync(join(tmpdir(), "gantry-data-"));
      dataDirs.push(data);
      const paths: GantryPaths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
      await indexRepo(paths, { layer: "main" });
      const store = openStore(paths.dbPath);
      try {
        dumps.push(JSON.stringify(dumpGraph(store), null, 2));
      } finally {
        store.close();
      }
    }
    expect(dumps[0]).toBe(dumps[1]);
    expect(dumps[0]?.length).toBeGreaterThan(100);
  });
});

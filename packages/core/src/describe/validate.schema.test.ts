import { describe, expect, it } from "vitest";
import {
  BATCH_RESULT_JSON_SCHEMA,
  BatchResultSchema,
  DESCRIPTION_JSON_SCHEMA,
  DescriptionSchema,
} from "./schema.js";

/** Minimal JSON Schema checker for the keywords our schemas use (no ajv: only approved dependencies). */
function valid(schema: Record<string, unknown>, v: unknown): boolean {
  const type = schema.type as string | undefined;
  if (type === "object") {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    const o = v as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const r of (schema.required ?? []) as string[]) if (!(r in o)) return false;
    for (const [k, val] of Object.entries(o)) {
      if (props[k] === undefined) {
        if (schema.additionalProperties === false) return false;
        continue;
      }
      if (!valid(props[k], val)) return false;
    }
    return true;
  }
  if (type === "array") {
    if (!Array.isArray(v)) return false;
    if (typeof schema.minItems === "number" && v.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && v.length > schema.maxItems) return false;
    return v.every((x) => valid(schema.items as Record<string, unknown>, x));
  }
  if (type === "string") {
    if (typeof v !== "string") return false;
    if (
      typeof schema.maxLength === "number" &&
      [...v].length > schema.maxLength &&
      v.length > schema.maxLength
    )
      return false;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(v)) return false;
    return true;
  }
  if (type === "boolean") return typeof v === "boolean";
  return false;
}

const base = { behavior: "Removes the cache.", searchTerms: ["clear cache"], nameFits: true };
const SAMPLES: [string, unknown][] = [
  ["minimal", base],
  ["with suggestedName", { ...base, nameFits: false, suggestedName: "clearCache" }],
  ["six terms", { ...base, searchTerms: ["a", "b", "c", "d", "e", "f"] }],
  ["200-char behavior", { ...base, behavior: "x".repeat(200) }],
  ["201-char behavior", { ...base, behavior: "x".repeat(201) }],
  ["30-char term", { ...base, searchTerms: ["x".repeat(30)] }],
  ["31-char term", { ...base, searchTerms: ["x".repeat(31)] }],
  ["no terms", { ...base, searchTerms: [] }],
  ["seven terms", { ...base, searchTerms: ["a", "b", "c", "d", "e", "f", "g"] }],
  ["missing behavior", { searchTerms: ["a"], nameFits: true }],
  ["missing searchTerms", { behavior: "x", nameFits: true }],
  ["missing nameFits", { behavior: "x", searchTerms: ["a"] }],
  ["nameFits string", { ...base, nameFits: "true" }],
  ["behavior number", { ...base, behavior: 1 }],
  ["terms not an array", { ...base, searchTerms: "a" }],
  ["term not a string", { ...base, searchTerms: [1] }],
  ["extra key", { ...base, extra: true }],
  ["bad suggestedName", { ...base, nameFits: false, suggestedName: "1abc" }],
  ["suggestedName with space", { ...base, nameFits: false, suggestedName: "a b" }],
  ["dollar suggestedName", { ...base, nameFits: false, suggestedName: "$el" }],
  ["null", null],
  ["array", []],
  ["string", "x"],
];

describe("zod and JSON Schema agree", () => {
  for (const [name, sample] of SAMPLES) {
    it(name, () => {
      expect(DescriptionSchema.safeParse(sample).success).toBe(valid(DESCRIPTION_JSON_SCHEMA, sample));
    });
  }

  it("batch result schema agrees too", () => {
    const batches: unknown[] = [
      { results: [] },
      { results: [{ content_key: "k", description: base }] },
      { results: [{ content_key: "k" }] },
      { results: [{ content_key: "k", description: { ...base, searchTerms: [] } }] },
      { results: [{ content_key: 1, description: base }] },
      { results: [{ content_key: "k", description: base, extra: 1 }] },
      {},
      { results: [], extra: 1 },
    ];
    for (const b of batches) {
      expect(BatchResultSchema.safeParse(b).success).toBe(valid(BATCH_RESULT_JSON_SCHEMA, b));
    }
  });

  it("the schema stays the M0 shape (no word limit, no minLength)", () => {
    expect(JSON.stringify(DESCRIPTION_JSON_SCHEMA)).not.toMatch(/minLength|words/);
    expect(DESCRIPTION_JSON_SCHEMA.required).toEqual(["behavior", "searchTerms", "nameFits"]);
  });
});

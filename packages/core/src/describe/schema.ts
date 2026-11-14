// Description schema (spec section 8): the JSON Schema handed to `claude -p --json-schema` and its zod twin.
// The word limit (25 words) cannot be expressed in JSON Schema, so it is a separate check in validate.ts.
import { z } from "zod";

export const MAX_BEHAVIOR_WORDS = 25;
export const MAX_BEHAVIOR_CHARS = 200;
export const MAX_TERM_CHARS = 30;
export const MIN_TERMS = 1;
export const MAX_TERMS = 6;
/** `suggestedName` must be a plain identifier. */
export const SUGGESTED_NAME_PATTERN = "^[A-Za-z_$][\\w$]*$";

export const DESCRIPTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    behavior: { type: "string", maxLength: MAX_BEHAVIOR_CHARS },
    searchTerms: {
      type: "array",
      minItems: MIN_TERMS,
      maxItems: MAX_TERMS,
      items: { type: "string", maxLength: MAX_TERM_CHARS },
    },
    nameFits: { type: "boolean" },
    suggestedName: { type: "string", pattern: SUGGESTED_NAME_PATTERN },
  },
  required: ["behavior", "searchTerms", "nameFits"],
  additionalProperties: false,
} as const;

export const BATCH_RESULT_JSON_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          content_key: { type: "string" },
          description: DESCRIPTION_JSON_SCHEMA,
        },
        required: ["content_key", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
} as const;

/** Zod twin of `DESCRIPTION_JSON_SCHEMA`; a test checks both accept and reject the same samples. */
export const DescriptionSchema = z.strictObject({
  behavior: z.string().max(MAX_BEHAVIOR_CHARS),
  searchTerms: z.array(z.string().max(MAX_TERM_CHARS)).min(MIN_TERMS).max(MAX_TERMS),
  nameFits: z.boolean(),
  suggestedName: z.string().regex(new RegExp(SUGGESTED_NAME_PATTERN)).optional(),
});

/** Zod twin of `BATCH_RESULT_JSON_SCHEMA`. */
export const BatchResultSchema = z.strictObject({
  results: z.array(z.strictObject({ content_key: z.string(), description: DescriptionSchema })),
});

/** Same shape without the length limits, so the validator can report `schema` and `length` separately. */
export const DescriptionShapeSchema = z.strictObject({
  behavior: z.string(),
  searchTerms: z.array(z.string()),
  nameFits: z.boolean(),
  suggestedName: z.string().regex(new RegExp(SUGGESTED_NAME_PATTERN)).optional(),
});

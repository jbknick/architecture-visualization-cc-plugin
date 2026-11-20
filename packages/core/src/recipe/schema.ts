import { z } from "zod";

/**
 * The recipe file `.gantry/recipe.json` (spec section 5): where routes, pages and endpoints are declared in this
 * repository, as data. A recipe is read, never evaluated: no field is run as code. Every object is strict, so an
 * unknown key is an error.
 */

/** Helpers a recipe may name; the engine runs the ones listed (`resolve-names` and `const-strings` are always on). */
export const HELPER_NAMES = [
  "resolve-names",
  "const-strings",
  "mount-graph",
  "call-return",
  "param-flow",
  "fs-routes",
] as const;
export type HelperName = (typeof HELPER_NAMES)[number];

/** File-system routing conventions `fs-routes` knows. */
export const FS_CONVENTIONS = ["tanstack-router"] as const;
export type FsConvention = (typeof FS_CONVENTIONS)[number];

type AstRule = Record<string, unknown>;

const strictness = z.enum(["cst", "smart", "ast", "relaxed", "signature"]);
const patternObject = z.strictObject({
  context: z.string().min(1),
  selector: z.string().min(1).optional(),
  strictness: strictness.optional(),
});

/** An ast-grep rule object, as `findAll` takes it. The keys are the ones ast-grep documents; nothing else passes. */
const astRule: z.ZodType<AstRule> = z.lazy(() =>
  z
    .strictObject({
      pattern: z.union([z.string().min(1), patternObject]).optional(),
      kind: z.string().min(1).optional(),
      regex: z.string().min(1).optional(),
      matches: z.string().min(1).optional(),
      nthChild: z
        .union([
          z.number().int().min(1),
          z.string().min(1),
          z.strictObject({
            position: z.union([z.number().int().min(1), z.string().min(1)]),
            reverse: z.boolean().optional(),
            ofRule: astRule.optional(),
          }),
        ])
        .optional(),
      all: z.array(astRule).min(1).optional(),
      any: z.array(astRule).min(1).optional(),
      not: astRule.optional(),
      inside: relational(),
      has: relational(),
      precedes: relational(),
      follows: relational(),
    })
    .refine((r) => Object.keys(r).length > 0, "a rule needs at least one key"),
);

function relational(): z.ZodOptional<z.ZodType<AstRule>> {
  return z
    .lazy(() =>
      z
        .strictObject({
          pattern: z.union([z.string().min(1), patternObject]).optional(),
          kind: z.string().min(1).optional(),
          regex: z.string().min(1).optional(),
          matches: z.string().min(1).optional(),
          all: z.array(astRule).min(1).optional(),
          any: z.array(astRule).min(1).optional(),
          not: astRule.optional(),
          inside: relational(),
          has: relational(),
          precedes: relational(),
          follows: relational(),
          stopBy: z.union([z.enum(["neighbor", "end"]), astRule]).optional(),
          field: z.string().min(1).optional(),
        })
        .refine((r) => Object.keys(r).length > 0, "a rule needs at least one key"),
    )
    .optional() as z.ZodOptional<z.ZodType<AstRule>>;
}

/** A capture: `$NAME` (one node), `$$$NAME` (all nodes of a multiple metavariable) or `=text` (a literal). */
const capture = z.string().regex(/^(\$\$\$[A-Z_][A-Z0-9_]*|\$[A-Z_][A-Z0-9_]*|=.+)$/, "not a capture");

/** The label written into the node's `data.adapter`. Optional because file routes carry none. */
const emitData = z.strictObject({ adapter: z.string().min(1).optional() }).optional();

export const EmitSchema = z.discriminatedUnion("kind", [
  /** A router instance (the match is its constructor); `base` is a base path of its own. */
  z.strictObject({ kind: z.literal("router"), base: capture.optional(), data: emitData }),
  /** `child` is reachable under `parent` at `prefix`. `childIsScope`: the child is a function whose first parameter is the router. */
  z.strictObject({
    kind: z.literal("mount"),
    parent: capture,
    prefix: capture.optional(),
    child: capture,
    childIsScope: z.boolean().optional(),
    data: emitData,
  }),
  /** A handler registration. `pathFromChain`: no path argument, reuse the previous call's path in the same chain. */
  z.strictObject({
    kind: z.literal("endpoint"),
    receiver: capture,
    method: capture,
    path: capture.optional(),
    handler: capture,
    pathFromChain: z.boolean().optional(),
    data: emitData,
  }),
  z.strictObject({
    kind: z.literal("middleware"),
    receiver: capture,
    path: capture.optional(),
    handler: capture,
    data: emitData,
  }),
  /** A page route; `id` is the framework's route id, `options` an object literal read for `component`, `loader`, `beforeLoad`. */
  z.strictObject({
    kind: z.literal("route"),
    id: capture.optional(),
    options: capture.optional(),
    root: z.boolean().optional(),
    data: emitData,
  }),
  /** A route whose id and URL come from the file's place in the routes folder, named by `convention`. */
  z.strictObject({
    kind: z.literal("fileRoute"),
    convention: z.enum(FS_CONVENTIONS),
    id: capture.optional(),
    options: capture.optional(),
    root: z.boolean().optional(),
    data: emitData,
  }),
]);
export type Emit = z.infer<typeof EmitSchema>;

export const RuleSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "id must match [A-Za-z0-9._-]+"),
  language: z.literal("typescript"),
  /** The rule runs only in workspaces that declare one of these packages. */
  when: z.strictObject({ dependency: z.array(z.string().min(1)).min(1).optional() }).optional(),
  /** Repo-relative picomatch globs; default every file of the workspace. */
  files: z.array(z.string().min(1)).optional(),
  rule: astRule,
  constraints: z.record(z.string(), astRule).optional(),
  emit: EmitSchema,
  /** Snippets that must match (each at least once) and snippets that must not, checked by `gantry recipe check`. */
  examples: z.strictObject({ match: z.array(z.string()), noMatch: z.array(z.string()) }),
});
export type RecipeRule = z.infer<typeof RuleSchema>;

export const DependencySchema = z.strictObject({
  name: z.string().min(1),
  workspace: z.string().min(1).optional(),
  role: z.enum(["framework", "data-access", "neither"]),
  note: z.string(),
});

/** The top level without its rules; load.ts checks each rule on its own so one bad rule does not drop the rest. */
export const RecipeShellSchema = z.strictObject({
  version: z.literal(1),
  dependencies: z.array(DependencySchema),
  helpers: z.array(z.enum(HELPER_NAMES)),
  rules: z.array(z.unknown()),
  /** Chain methods that return the same router (`r.With(mw).Get`, `new Hono().basePath(..).get(..)`). */
  passthrough: z.array(z.string().min(1)).optional(),
});

export const RecipeSchema = RecipeShellSchema.extend({ rules: z.array(RuleSchema) });
export type Recipe = z.infer<typeof RecipeSchema>;

export const zodMessage = (err: z.ZodError): string =>
  err.issues.map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; ");

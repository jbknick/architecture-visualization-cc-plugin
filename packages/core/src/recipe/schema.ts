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
  "sql-text",
  "text-rules",
  "model-naming",
  "method-classes",
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

/** A capture that reads as text: a capture, a literal, or `@class` (the name of the class a matched decorator decorates). */
const textCapture = z
  .string()
  .regex(/^(\$[A-Z_][A-Z0-9_]*|=.+|@class)$/, "not a text capture ($NAME, =text or @class)");

/**
 * A field of a table node's `data`. `$X` is the capture's text (a string literal's value); `@exportName`, `@symbol`,
 * `@file`, `@line` and `@name` are what the engine knows about the declaration; `{ "keysOf": "$X" }` is the property
 * names of the object literal a capture holds (or that a function it holds returns); any other string is a literal
 * (a leading `=` is dropped).
 */
const dataValue = z.union([z.string(), z.strictObject({ keysOf: capture })]);
const tableData = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "not a field name"), dataValue);

/**
 * A read or a write of a table by the code around the match. The table comes from `table` (an expression bound to a
 * table: a string, an identifier, `ns.member`, or a call named in `tablePassthrough`), from `model` (a model name,
 * `$$$` for several) or from `receiver`: its declaration text is matched against the `receiverDecl` regexes, whose
 * first group is the model (`{prop}` stands for the member name). With `method`, the match counts only when the
 * recipe's `methods` list puts that method in this emit's class.
 */
const accessShape = {
  table: capture.optional(),
  model: capture.optional(),
  receiver: capture.optional(),
  receiverDecl: z.array(z.string().min(1)).min(1).optional(),
  method: capture.optional(),
  data: emitData,
};
const hasTableSource = (e: { table?: string; model?: string; receiver?: string; receiverDecl?: string[] }) =>
  Boolean(e.table || e.model || (e.receiver && e.receiverDecl));

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
  /**
   * A table (a collection counts as a table). `name` is the first capture that reads as text; one that cannot be read
   * makes a table named `{<expression>}` with `data.reason`. `model` is the name the code uses for the table (an
   * entity, class or export name). `binding`: the identifier the match is assigned to stands for the table in later
   * code. `data` is carried into the node's data.
   */
  z.strictObject({
    kind: z.literal("table"),
    name: z.union([textCapture, z.array(textCapture).min(1)]),
    model: textCapture.optional(),
    binding: z.boolean().optional(),
    data: tableData.optional(),
  }),
  z
    .strictObject({ kind: z.literal("read"), ...accessShape })
    .refine(hasTableSource, "needs table, model, or receiver with receiverDecl"),
  z
    .strictObject({ kind: z.literal("write"), ...accessShape })
    .refine(hasTableSource, "needs table, model, or receiver with receiverDecl"),
]);
export type Emit = z.infer<typeof EmitSchema>;

const ruleId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "id must match [A-Za-z0-9._-]+");
/**
 * The rule runs only in workspaces that declare one of these packages. `viaWorkspaces` widens that to workspaces
 * that depend on a workspace of the repository that declares one (a package using a schema defined in another).
 */
const whenSchema = z
  .strictObject({
    dependency: z.array(z.string().min(1)).min(1).optional(),
    viaWorkspaces: z.boolean().optional(),
  })
  .optional();

export const TsRuleSchema = z.strictObject({
  id: ruleId,
  language: z.literal("typescript"),
  when: whenSchema,
  /** Repo-relative picomatch globs; default every file of the workspace. */
  files: z.array(z.string().min(1)).optional(),
  rule: astRule,
  constraints: z.record(z.string(), astRule).optional(),
  emit: EmitSchema,
  /** Snippets that must match (each at least once) and snippets that must not, checked by `gantry recipe check`. */
  examples: z.strictObject({ match: z.array(z.string()), noMatch: z.array(z.string()) }),
});
export type RecipeRule = z.infer<typeof TsRuleSchema>;

/** A regex group of a text rule (`$1`) or a literal (`=text`). */
const groupRef = z.string().regex(/^(\$\d+|=.+)$/, "not a group reference ($1) or a literal (=text)");

/**
 * A rule over files that have no syntax tree in the index (a schema file, SQL migrations): `files` globs are
 * required, `rule.regex` is matched against the whole text (flags default `gm`), `$1`, `$2` ... are its groups.
 * A text rule emits tables; the table node belongs to the first TypeScript file of the text file's workspace,
 * because only files with a syntax tree are rows of the index.
 */
export const TextRuleSchema = z.strictObject({
  id: ruleId,
  language: z.literal("text"),
  when: whenSchema,
  files: z.array(z.string().min(1)).min(1),
  rule: z.strictObject({
    regex: z.string().min(1),
    flags: z
      .string()
      .regex(/^[gimsuy]*$/, "flags are letters of gimsuy")
      .optional(),
  }),
  emit: z.strictObject({
    kind: z.literal("table"),
    name: z.union([groupRef, z.array(groupRef).min(1)]),
    model: groupRef.optional(),
    data: tableData.optional(),
  }),
  examples: z.strictObject({ match: z.array(z.string()), noMatch: z.array(z.string()) }),
});
export type TextRecipeRule = z.infer<typeof TextRuleSchema>;

export const RuleSchema = z.union([TsRuleSchema, TextRuleSchema]);
export type AnyRecipeRule = RecipeRule | TextRecipeRule;
export const isTextRule = (r: AnyRecipeRule): r is TextRecipeRule => r.language === "text";
export const isTsRule = (r: AnyRecipeRule): r is RecipeRule => r.language === "typescript";

/** The schema a raw rule is checked against: its `language` picks one, so an error names that schema's problem. */
export const ruleSchemaFor = (raw: unknown) =>
  (raw as { language?: unknown } | null)?.language === "text" ? TextRuleSchema : TsRuleSchema;

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
  /** `model-naming`: how a model name maps to a table name (an explicit map, `snake_case`, plural, or both). */
  models: z
    .strictObject({
      explicit: z.record(z.string(), z.string().min(1)).optional(),
      snakeCase: z.boolean().optional(),
      plural: z.boolean().optional(),
    })
    .optional(),
  /** `method-classes`: the methods that read and the methods that write (see the `method` of a read or write emit). */
  methods: z
    .strictObject({
      read: z.array(z.string().min(1)).optional(),
      write: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  /** Calls that stand for their first argument when read as a table (`alias(users, "a")`). */
  tablePassthrough: z.array(z.string().min(1)).optional(),
  /**
   * `sql-text`: scan the strings, template literals and tagged templates of TypeScript files (`files`, default all;
   * `exclude` globs are left out) and the text files `sqlFiles` names. `tags`: tagged templates that are SQL whatever
   * they start with.
   */
  sql: z
    .strictObject({
      tags: z.array(z.string().min(1)).optional(),
      files: z.array(z.string().min(1)).optional(),
      exclude: z.array(z.string().min(1)).optional(),
      sqlFiles: z.array(z.string().min(1)).optional(),
    })
    .optional(),
});

export const RecipeSchema = RecipeShellSchema.extend({ rules: z.array(RuleSchema) });
export type Recipe = z.infer<typeof RecipeSchema>;

export const zodMessage = (err: z.ZodError): string =>
  err.issues.map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; ");

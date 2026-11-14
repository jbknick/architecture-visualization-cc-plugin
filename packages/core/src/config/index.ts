import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { GantryPaths } from "../paths/index.js";

const TASK_NAMES = [
  "describe.init",
  "describe.sync",
  "describe.precommit",
  "describe.retry",
  "overview",
  "explain",
] as const;

const RouteSchema = z.object({
  model: z.enum(["haiku", "sonnet", "opus"]),
  effort: z.enum(["low", "medium", "high"]),
});

export const GantryConfigSchema = z.object({
  precommit: z.object({
    mode: z.enum(["off", "timeboxed", "strict"]),
    budgetMs: z.number().int().nonnegative(),
    maxFunctions: z.number().int().nonnegative(),
  }),
  routing: z.object({
    "describe.init": RouteSchema,
    "describe.sync": RouteSchema,
    "describe.precommit": RouteSchema,
    "describe.retry": RouteSchema,
    overview: RouteSchema,
    explain: RouteSchema,
  }),
  exclude: z.array(z.string()),
  workspaces: z.object({
    overrides: z.record(z.string(), z.object({ kind: z.enum(["app", "package"]).optional() })),
  }),
  duplicates: z.object({
    mode: z.enum(["warn", "block"]),
    ignore: z.array(z.string()),
    thresholds: z.object({
      nearJaccard: z.number().min(0).max(1),
      codeVector: z.number().min(0).max(1),
      semantic: z.number().min(0).max(1),
    }),
  }),
  backlogReminderThreshold: z.number().int().nonnegative(),
  renameSuggestions: z.boolean(),
  views: z.object({ slices: z.array(z.string()) }),
});

export type TaskName = (typeof TASK_NAMES)[number];
export type GantryConfig = z.infer<typeof GantryConfigSchema>;

type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Spec section 5 built-in excludes. "Everything git ignores" is handled by discovery, not here. */
export const BUILTIN_EXCLUDES: readonly string[] = [
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".output",
  ".turbo",
  ".vercel",
  ".wrangler",
  "coverage",
  "**/*.d.ts",
  "**/*.gen.ts",
  "**/routeTree.gen.ts",
  ".claude/worktrees",
  ".env*",
  "*.pem",
  "*.key",
  "*.p12",
  "id_rsa*",
  ".npmrc",
  "credentials*",
  "secrets*",
  "*.tfvars",
];

function defaults(): GantryConfig {
  return {
    precommit: { mode: "off", budgetMs: 8000, maxFunctions: 50 },
    routing: {
      "describe.init": { model: "haiku", effort: "low" },
      "describe.sync": { model: "haiku", effort: "low" },
      "describe.precommit": { model: "haiku", effort: "low" },
      "describe.retry": { model: "sonnet", effort: "low" },
      overview: { model: "sonnet", effort: "low" },
      explain: { model: "sonnet", effort: "medium" },
    },
    exclude: [],
    workspaces: { overrides: {} },
    duplicates: {
      mode: "warn",
      ignore: [],
      thresholds: { nearJaccard: 0.85, codeVector: 0.96, semantic: 0.6 },
    },
    backlogReminderThreshold: 100,
    renameSuggestions: false,
    views: { slices: ["apps/*/src/features/*", "apps/*/src/modules/*", "packages/*"] },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Objects merge recursively; arrays and scalars replace. Inputs are not mutated. */
function deepMerge(base: unknown, over: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(over)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) {
      out[k] = k in base ? deepMerge(base[k], v) : v;
    }
    return out;
  }
  return over;
}

function readJsonObject(file: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined; // missing file is not an error
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) throw new Error("config must be a JSON object");
  return parsed;
}

function applyLayer(file: string, prev: GantryConfig): GantryConfig {
  try {
    const layer = readJsonObject(file);
    if (!layer) return prev;
    const result = GantryConfigSchema.safeParse(deepMerge(prev, layer));
    if (!result.success) throw new Error(result.error.message);
    return result.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`gantry: ignoring invalid config ${file}: ${msg}\n`);
    return prev;
  }
}

/** defaults <- global <- project. Invalid layers are skipped with a stderr warning. */
export function loadConfig(p: GantryPaths): GantryConfig {
  const base = GantryConfigSchema.parse(defaults());
  return applyLayer(p.configPath, applyLayer(p.globalConfigPath, base));
}

/** Merge `patch` into the project config file (validated, written atomically). Returns the effective config. */
export function saveProjectConfig(p: GantryPaths, patch: DeepPartial<GantryConfig>): GantryConfig {
  let existing: Record<string, unknown> = {};
  try {
    existing = readJsonObject(p.configPath) ?? {};
  } catch {
    existing = {}; // unreadable project file is replaced by the validated patch
  }
  const nextProject = deepMerge(existing, patch);

  const base = applyLayer(p.globalConfigPath, GantryConfigSchema.parse(defaults()));
  const result = GantryConfigSchema.safeParse(deepMerge(base, nextProject));
  if (!result.success) {
    throw new Error(`Invalid config patch: ${result.error.message}`);
  }

  fs.mkdirSync(path.dirname(p.configPath), { recursive: true, mode: 0o700 });
  const tmp = `${p.configPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(nextProject, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, p.configPath);
  return result.data;
}

/**
 * Config for the data directory that holds `dbPath` (`<dataDir>/gantry.db`), without resolving git paths.
 * For library code that only has a store (the duplicate engine reads thresholds on every call).
 */
export function loadConfigForDb(dbPath: string, env: NodeJS.ProcessEnv = process.env): GantryConfig {
  const home = env.HOME || os.homedir();
  return loadConfig({
    configPath: path.join(path.dirname(dbPath), "config.json"),
    globalConfigPath: path.join(home, ".gantry", "config.json"),
  } as GantryPaths);
}

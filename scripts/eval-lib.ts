// Shared code of the OSS evaluation corpus (spec section 13): the repos.json and label schemas, the
// key rules, predictions read from an `index --dump`, and the scorer. No network, no git.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const reposPath = join(repoRoot, "evals/oss/repos.json");
export const labelsDir = join(repoRoot, "evals/oss/labels");
export const recipesDir = join(repoRoot, "evals/oss/recipes");

/** The bar every scored kind must reach. */
export const BAR = { recall: 0.9, precision: 0.95 } as const;

export const KINDS = ["route", "endpoint", "table", "read", "write", "link"] as const;
export type Kind = (typeof KINDS)[number];

const sha = z.string().regex(/^[0-9a-f]{40}$/, "sha must be 40 lowercase hex characters");

const repoSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9._-]+$/, "name must match [a-z0-9._-]+"),
  url: z
    .string()
    .refine((u) => u.startsWith("https://") || u.startsWith("file://"), "url must be https or file://"),
  sha,
  stack: z.array(z.string().regex(/^[^A-Z\s]+$/, "stack entries are lowercase")).min(1),
  lang: z.array(z.enum(["ts", "go"])),
  role: z.enum(["tuning", "held-out"]),
});

export const reposSchema = z.strictObject({ repos: z.array(repoSchema) }).superRefine(({ repos }, ctx) => {
  const seen = new Set<string>();
  repos.forEach((r, i) => {
    if (seen.has(r.name))
      ctx.addIssue({ code: "custom", message: `duplicate name ${r.name}`, path: ["repos", i] });
    seen.add(r.name);
    const prev = repos[i - 1];
    if (prev && prev.name > r.name)
      ctx.addIssue({ code: "custom", message: "entries must be sorted by name", path: ["repos", i] });
  });
});
export type Repo = z.infer<typeof repoSchema>;

const file = z.string().min(1);
/** `repo/relative/path.go:123`: where a handler is declared. Informational, checked by check-labels only. */
const handlerRef = z.string().regex(/^[^:\s]+:[1-9]\d*$/, "handler must be <repo-relative path>:<line>");
const line = z.number().int().positive();
/** The functions that read or write a table in the pair's file, each with its declaration line. */
const fns = z.array(z.strictObject({ name: z.string().min(1), line })).min(1);
const endpointLabel = z.union([
  z.strictObject({
    method: z.string().min(1),
    path: z.string().min(1),
    file,
    handler: handlerRef.optional(),
  }),
  z.strictObject({ rpc: z.string().min(1), file }),
  z.strictObject({ fn: z.string().min(1), file }),
]);
export type EndpointLabel = z.infer<typeof endpointLabel>;

export const labelsSchema = z.strictObject({
  repo: z.string().min(1),
  sha,
  labelledBy: z.string().min(1),
  kinds: z.array(z.enum(KINDS)),
  route: z.array(z.strictObject({ path: z.string().min(1), file })).default([]),
  endpoint: z.array(endpointLabel).default([]),
  table: z.array(z.strictObject({ name: z.string().min(1) })).default([]),
  read: z.array(z.strictObject({ file, table: z.string().min(1), fns: fns.optional() })).default([]),
  write: z.array(z.strictObject({ file, table: z.string().min(1), fns: fns.optional() })).default([]),
  link: z.array(z.strictObject({ file, endpoint: z.string().min(1) })).default([]),
  /** Sites whose path or table name cannot be read from the code. Never scored. */
  unresolved: z.array(z.strictObject({ file, line, reason: z.string().min(1) })).default([]),
});
export type Labels = z.infer<typeof labelsSchema>;

/** The slice of `index --dump` the scorer reads. */
export const dumpSchema = z.looseObject({
  files: z.array(z.looseObject({ id: z.string(), path: z.string() })),
  edges: z.array(
    z.looseObject({
      src: z.string(),
      dst: z.string(),
      kind: z.string(),
      confidence: z.string(),
      fileId: z.string(),
    }),
  ),
  // The dump leaves `adapterNodes` out when no adapter found anything (a repo with no recipe yet).
  adapterNodes: z
    .array(z.looseObject({ id: z.string(), kind: z.string(), data: z.record(z.string(), z.unknown()) }))
    .default([]),
});
export type Dump = z.infer<typeof dumpSchema>;

export class InputError extends Error {}

export function readJson<T>(path: string, schema: z.ZodType<T>, what: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new InputError(`${what} ${path}: ${(err as Error).message}`);
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new InputError(`${what} ${path} is invalid: ${issues}`);
  }
  return r.data;
}

export const readRepos = (path = reposPath) => readJson(path, reposSchema, "repos file").repos;

/** Where clones live, outside this repository. */
export const ossDir = () => process.env.GANTRY_OSS_DIR || join(homedir(), "Dev", "gantry-oss");
export const targetDir = (r: Repo, base = ossDir()) => join(base, `${r.name}@${r.sha.slice(0, 7)}`);

// ---- keys ----

/** Dynamic segments (`:x`, `$x`, `[x]`, `{x}`) become `:param`; `/` runs collapse; a trailing `/` is dropped. */
export function normPath(p: string): string {
  const segs = p
    .split("/")
    .filter((s) => s !== "")
    .map((s) => (/^[:$]/.test(s) || /^\[.*\]$/.test(s) || /^\{.*\}$/.test(s) ? ":param" : s));
  return `/${segs.join("/")}`;
}

export const routeKey = (path: string) => normPath(path);
export const endpointKey = (e: EndpointLabel) =>
  "rpc" in e ? `rpc ${e.rpc}` : "fn" in e ? `fn ${e.fn}` : `${e.method.toUpperCase()} ${normPath(e.path)}`;
export const tableKey = (name: string) => name.toLowerCase();
export const fileTableKey = (file: string, table: string) => `${file}|${tableKey(table)}`;

/** A link label names its endpoint as text (`GET /api/x/:id`, `rpc a.b`, `fn name`); normalise it like a key. */
export function endpointText(text: string): string {
  const t = text.trim();
  if (t.startsWith("rpc ") || t.startsWith("fn ")) return t;
  const i = t.indexOf(" ");
  return i < 0 ? t : `${t.slice(0, i).toUpperCase()} ${normPath(t.slice(i + 1))}`;
}
export const linkKey = (file: string, endpoint: string) => `${file}|${endpointText(endpoint)}`;

/** One key function per kind, applied to a label entry. */
export function keyOf<K extends Kind>(kind: K, item: Labels[K][number]): string {
  switch (kind) {
    case "route":
      return routeKey((item as Labels["route"][number]).path);
    case "endpoint":
      return endpointKey(item as EndpointLabel);
    case "table":
      return tableKey((item as Labels["table"][number]).name);
    case "read":
    case "write": {
      const x = item as Labels["read"][number];
      return fileTableKey(x.file, x.table);
    }
    default: {
      const x = item as Labels["link"][number];
      return linkKey(x.file, x.endpoint);
    }
  }
}

export function labelKeys(labels: Labels): Record<Kind, string[]> {
  const out = {} as Record<Kind, string[]>;
  for (const k of KINDS)
    out[k] = unique((labels[k] as Labels[Kind][number][]).map((i) => keyOf(k, i as never)));
  return out;
}

/** Duplicate keys within one kind of a label file are an input error. */
export function duplicateLabelKeys(labels: Labels): string[] {
  const dups: string[] = [];
  for (const k of KINDS) {
    const keys = (labels[k] as Labels[Kind][number][]).map((i) => keyOf(k, i as never));
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) dups.push(`${k}: ${key}`);
      seen.add(key);
    }
  }
  return dups;
}

const unique = (xs: string[]) => [...new Set(xs)].sort();

// ---- predictions ----

export interface Predictions {
  route: string[];
  endpoint: string[];
  table: string[];
  read: string[];
  write: string[];
  link: { key: string; confidence: string }[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The endpoint key of an adapter node, from its own `data`; undefined when it names no endpoint. */
export function endpointKeyOfNode(n: Dump["adapterNodes"][number]): string | undefined {
  const d = n.data;
  if (d.adapter === "orpc") {
    const p = str(d.path);
    return p && `rpc ${p}`;
  }
  const method = str(d.method);
  const path = str(d.path);
  if (method && path) return `${method.toUpperCase()} ${normPath(path)}`;
  const name = str(d.name);
  return name && `fn ${name}`;
}

/**
 * Predictions from the dump's own records: node `data` and edge `fileId`, never id strings. A node that carries
 * `data.reason` (a path or a table name known only at run time, spec section 9) is visible in the index but not
 * scored, whatever its kind, and neither are the edges that end at it.
 */
export function predictionsOf(dump: Dump): Predictions {
  const scored = dump.adapterNodes.filter((n) => n.data.reason === undefined);
  const nodes = new Map(scored.map((n) => [n.id, n]));
  const filePath = new Map(dump.files.map((f) => [f.id, f.path]));

  const route: string[] = [];
  const endpoint: string[] = [];
  const table: string[] = [];
  for (const n of scored) {
    if (n.kind === "route") {
      const p = str(n.data.urlPath);
      if (p) route.push(routeKey(p));
    } else if (n.kind === "endpoint") {
      const k = endpointKeyOfNode(n);
      if (k) endpoint.push(k);
    } else if (n.kind === "table") {
      const name = str(n.data.name);
      if (name) table.push(tableKey(name));
    }
  }

  const read: string[] = [];
  const write: string[] = [];
  const links = new Map<string, string>();
  for (const e of dump.edges) {
    const f = filePath.get(e.fileId);
    const dst = nodes.get(e.dst);
    if (!f || !dst) continue;
    if (e.kind === "reads" || e.kind === "writes") {
      const name = dst.kind === "table" ? str(dst.data.name) : undefined;
      if (name) (e.kind === "reads" ? read : write).push(fileTableKey(f, name));
    } else if (e.kind === "requests" && dst.kind === "endpoint") {
      const ek = endpointKeyOfNode(dst);
      if (!ek) continue;
      const key = `${f}|${ek}`;
      // A link seen twice is high when any of its edges is high.
      links.set(key, links.get(key) === "high" || e.confidence === "high" ? "high" : e.confidence);
    }
  }
  return {
    route: unique(route),
    endpoint: unique(endpoint),
    table: unique(table),
    read: unique(read),
    write: unique(write),
    link: [...links]
      .map(([key, confidence]) => ({ key, confidence }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}

// ---- scoring ----

const round4 = (n: number) => Math.round(n * 10000) / 10000;

export interface KindScore {
  labelled: number;
  predicted: number;
  matched: number;
  precision: number;
  recall: number;
  wrongHigh?: number;
  pass: boolean;
}
export interface Score {
  case: string;
  sha: string;
  bar: { recall: number; precision: number };
  kinds: Record<string, KindScore>;
  missed: Record<string, string[]>;
  extra: Record<string, string[]>;
  pass: boolean;
}

export function score(name: string, labels: Labels, dump: Dump): Score {
  const lk = labelKeys(labels);
  const pred = predictionsOf(dump);
  const kinds: Record<string, KindScore> = {};
  const missed: Record<string, string[]> = {};
  const extra: Record<string, string[]> = {};
  for (const kind of [...labels.kinds].sort()) {
    const labelled = new Set(lk[kind]);
    const predictedList = kind === "link" ? pred.link.map((l) => l.key) : pred[kind];
    const predicted = new Set(predictedList);
    const matched = [...predicted].filter((k) => labelled.has(k)).length;
    const precision = predicted.size === 0 ? 1 : matched / predicted.size;
    const recall = labelled.size === 0 ? 1 : matched / labelled.size;
    let pass = recall >= BAR.recall && precision >= BAR.precision;
    const ks: KindScore = {
      labelled: labelled.size,
      predicted: predicted.size,
      matched,
      precision: round4(precision),
      recall: round4(recall),
      pass,
    };
    if (kind === "link") {
      ks.wrongHigh = pred.link.filter((l) => l.confidence === "high" && !labelled.has(l.key)).length;
      pass = pass && ks.wrongHigh === 0;
      ks.pass = pass;
    }
    kinds[kind] = ks;
    const m = [...labelled].filter((k) => !predicted.has(k)).sort();
    const x = [...predicted].filter((k) => !labelled.has(k)).sort();
    if (m.length) missed[kind] = m;
    if (x.length) extra[kind] = x;
  }
  return {
    case: name,
    sha: labels.sha,
    bar: { recall: BAR.recall, precision: BAR.precision },
    kinds,
    missed,
    extra,
    pass: Object.values(kinds).every((k) => k.pass),
  };
}

/** Validates labels against the repo entry; returns a problem text or null. */
export function labelsProblem(labels: Labels, repo: Repo): string | null {
  if (labels.repo !== repo.name) return `labels are for ${labels.repo}, not ${repo.name}`;
  if (labels.sha !== repo.sha) return `labels sha ${labels.sha} differs from repos.json sha ${repo.sha}`;
  const dups = duplicateLabelKeys(labels);
  if (dups.length) return `duplicate label keys: ${dups.join(", ")}`;
  return null;
}

// ---- running the built CLI ----

/** The built CLI; `GANTRY_EVAL_CLI` points the tests at a stand-in. */
export const cliPath = process.env.GANTRY_EVAL_CLI || join(repoRoot, "plugin/dist/cli.js");

export function headOf(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * `index --dump` of a clone, with fresh temp `CLAUDE_PLUGIN_DATA` and `HOME`. With a recipe, the clone is copied
 * (`cp -R`, `.git` included) and the recipe written into the copy; the clone itself is never written.
 */
export function runDump(clone: string, recipe?: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "gantry-eval-"));
  try {
    let cwd = clone;
    if (recipe !== undefined) {
      cwd = join(tmp, "copy");
      execFileSync("cp", ["-R", clone, cwd], { stdio: "ignore" });
      mkdirSync(join(cwd, ".gantry"), { recursive: true });
      copyFileSync(recipe, join(cwd, ".gantry", "recipe.json"));
      // The main layer reads the recipe from HEAD (spec section 5), so the copy commits it. The copy is a temp
      // directory; the clone itself is never touched.
      const git = (args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
      git(["add", "-f", ".gantry/recipe.json"]);
      git(["-c", "user.email=eval@example.invalid", "-c", "user.name=eval", "commit", "-q", "-m", "recipe"]);
    }
    const data = join(tmp, "data");
    const home = join(tmp, "home");
    mkdirSync(data);
    mkdirSync(home);
    return execFileSync(process.execPath, [cliPath, "index", "--dump"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1 << 30,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data, HOME: home },
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export const parseDump = (text: string): Dump => {
  const r = dumpSchema.safeParse(JSON.parse(text));
  if (!r.success) throw new InputError(`not an index --dump: ${r.error.issues[0]?.message}`);
  return r.data;
};

/** Clone of a case, checked to exist at its SHA and the CLI to be built; throws InputError otherwise. */
export function requireCloneAndBuild(repo: Repo): string {
  if (!existsSync(cliPath)) throw new InputError("plugin/dist/cli.js is missing: run pnpm build");
  const dir = targetDir(repo);
  if (!existsSync(dir) || headOf(dir) !== repo.sha)
    throw new InputError(`${dir} is missing or not at ${repo.sha}: run pnpm eval:clone`);
  return dir;
}

export function loadCase(
  name: string,
  opts: { repos?: string; labels?: string; labelsDir?: string },
): { repo: Repo; labels: Labels } {
  const repo = readRepos(opts.repos ? resolve(opts.repos) : undefined).find((r) => r.name === name);
  if (!repo) throw new InputError(`unknown case ${name}`);
  const labelsFile = opts.labels
    ? resolve(opts.labels)
    : join(opts.labelsDir ? resolve(opts.labelsDir) : labelsDir, `${name}.json`);
  if (!existsSync(labelsFile)) throw new InputError(`no labels for ${name}: ${labelsFile}`);
  const labels = readJson(labelsFile, labelsSchema, "labels file");
  const problem = labelsProblem(labels, repo);
  if (problem) throw new InputError(problem);
  return { repo, labels };
}

/** Flag parser shared by the scripts: `--flag value`, and `--only a b c` taking values until the next flag. */
export function parseFlags(argv: string[], single: string[], multi: string[]) {
  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (single.includes(a)) {
      const v = argv[++i];
      if (v === undefined) throw new InputError(`${a} needs a value`);
      values[a.slice(2)] = v;
    } else if (multi.includes(a)) {
      const l = lists[a.slice(2)] ?? [];
      lists[a.slice(2)] = l;
      while (argv[i + 1] !== undefined && !(argv[i + 1] as string).startsWith("--"))
        l.push(argv[++i] as string);
    } else if (a.startsWith("--")) throw new InputError(`unknown argument ${a}`);
    else positional.push(a);
  }
  return { values, lists, positional };
}

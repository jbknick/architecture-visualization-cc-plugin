// Call-linking cases of the OSS evaluation corpus (spec section 13): the label schema, the self-check of
// labels against clones, and the scorer. A case `linking-<x>` has one label file with one entry per request
// call site of its frontend repo(s) and, for each, the endpoint it reaches or null with a reason.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  BAR,
  type Dump,
  endpointKeyOfNode,
  InputError,
  labelsDir,
  normPath,
  parseDump,
  type Repo,
  readJson,
  readRepos,
  requireCloneAndBuild,
  runDump,
  targetDir,
} from "./eval-lib.js";

export const LINKING_PREFIX = "linking-";
export const MIN_LINKABLE = 20;
export const NULL_REASONS = ["external", "dynamic", "wrapper_body", "no_such_endpoint", "ambiguous"] as const;

export const isLinkingCase = (name: string) => name.startsWith(LINKING_PREFIX);

const sha = z.string().regex(/^[0-9a-f]{40}$/, "sha must be 40 lowercase hex characters");
const method = z
  .string()
  .regex(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)$/, "upper-case HTTP method or ANY");
const nonEmpty = z.string().min(1);

const expectSchema = z.strictObject({ repo: nonEmpty, workspace: nonEmpty, method, path: nonEmpty });
const siteSchema = z.strictObject({
  repo: nonEmpty,
  file: nonEmpty,
  line: z.number().int().min(1),
  method,
  path: nonEmpty,
  expect: expectSchema.nullable(),
  reason: z.enum(NULL_REASONS).optional(),
  note: nonEmpty.optional(),
});

export const linkingSchema = z.strictObject({
  case: z.string().regex(/^linking-[a-z0-9._-]+$/),
  repos: z.array(z.strictObject({ name: nonEmpty, sha })).min(1),
  labelledBy: nonEmpty,
  requests: z.array(siteSchema),
});
export type LinkingLabels = z.infer<typeof linkingSchema>;
export type Site = z.infer<typeof siteSchema>;

/** Why a label file is wrong beyond its shape: unknown repo, wrong sha, a reason missing or stray, duplicates. */
export function linkingProblems(labels: LinkingLabels, repos: Repo[]): string[] {
  const out: string[] = [];
  const known = new Map(repos.map((r) => [r.name, r]));
  const inCase = new Set(labels.repos.map((r) => r.name));
  for (const r of labels.repos) {
    const entry = known.get(r.name);
    if (!entry) out.push(`repo ${r.name} is not in repos.json`);
    else if (entry.sha !== r.sha)
      out.push(`repo ${r.name}: sha ${r.sha} differs from repos.json ${entry.sha}`);
  }
  const seen = new Set<string>();
  for (const s of labels.requests) {
    const where = `${s.repo}:${s.file}:${s.line}`;
    if (!inCase.has(s.repo)) out.push(`${where}: repo is not in the case`);
    if (s.expect && !inCase.has(s.expect.repo) && !known.has(s.expect.repo))
      out.push(`${where}: expect.repo ${s.expect.repo} is unknown`);
    if (s.expect === null && !s.reason) out.push(`${where}: a null expect needs a reason`);
    if (s.expect !== null && s.reason) out.push(`${where}: a reason belongs only to a null expect`);
    const key = `${where}|${s.method}|${s.path}`;
    if (seen.has(key)) out.push(`${where}: duplicate label ${s.method} ${s.path}`);
    seen.add(key);
  }
  return out;
}

export function loadLinkingCase(
  name: string,
  opts: { repos?: string; labels?: string; labelsDir?: string } = {},
): { labels: LinkingLabels; repos: Repo[] } {
  const all = readRepos(opts.repos ? resolve(opts.repos) : undefined);
  const file = opts.labels ?? join(opts.labelsDir ? resolve(opts.labelsDir) : labelsDir, `${name}.json`);
  if (!existsSync(file)) throw new InputError(`no labels for ${name}: ${file}`);
  const labels = readJson(file, linkingSchema, "labels file");
  if (labels.case !== name) throw new InputError(`labels file ${file} is for ${labels.case}, not ${name}`);
  const problems = linkingProblems(labels, all);
  if (problems.length) throw new InputError(`labels for ${name}: ${problems.join("; ")}`);
  const repos = labels.repos.map((r) => all.find((a) => a.name === r.name) as Repo);
  return { labels, repos };
}

// ---- self-check against the clones ----

/**
 * A request site's line holds a call: an identifier, `]`, `)` or `>` (a type argument list) then `(`, or an
 * identifier whose type argument list opens at the end of the line (`apiFetch<{`, the `(` is on a later line).
 */
export const hasCall = (line: string) => /[\w$\])>]\s*\(/.test(line) || /\w<\{?\s*$/.test(line);

/** Problems of the labels against clones (`cloneOf` gives a repo's clone directory); empty when all is well. */
export function checkLinking(labels: LinkingLabels, cloneOf: (repo: string) => string): string[] {
  const out: string[] = [];
  const cache = new Map<string, string[] | null>();
  const linesOf = (repo: string, file: string) => {
    const path = join(cloneOf(repo), file);
    if (!cache.has(path)) cache.set(path, existsSync(path) ? readFileSync(path, "utf8").split("\n") : null);
    return cache.get(path) as string[] | null;
  };
  for (const s of labels.requests) {
    const where = `${s.repo}:${s.file}:${s.line}`;
    const lines = linesOf(s.repo, s.file);
    if (!lines) out.push(`${where}: file does not exist`);
    else if (s.line > lines.length) out.push(`${where}: line is past the end (${lines.length} lines)`);
    else if (!hasCall(lines[s.line - 1] as string)) out.push(`${where}: line holds no call`);
  }
  const linkable = labels.requests.filter((s) => s.expect !== null).length;
  if (linkable < MIN_LINKABLE)
    out.push(
      `only ${linkable} linkable labels, ${MIN_LINKABLE} needed: ask the maintainer for a replacement repo`,
    );
  return out;
}

// ---- scoring ----

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const endpointText = (repo: string, method: string, path: string) =>
  `${repo}:${method.toUpperCase()} ${normPath(path)}`;
const siteKey = (repo: string, file: string, line: number, endpoint: string) =>
  `${repo}|${file}:${line}|${endpoint}`;

export const labelKey = (s: Site & { expect: NonNullable<Site["expect"]> }) =>
  siteKey(s.repo, s.file, s.line, endpointText(s.expect.repo, s.expect.method, s.expect.path));

/** Links of one repo's dump: a `requests` edge to an endpoint node, one per evidence line (`path:line`). */
export function linkSites(repo: string, dump: Dump): { key: string; confidence: string }[] {
  const nodes = new Map(dump.adapterNodes.map((n) => [n.id, n]));
  const filePath = new Map(dump.files.map((f) => [f.id, f.path]));
  const links = new Map<string, string>();
  for (const e of dump.edges) {
    if (e.kind !== "requests") continue;
    const dst = nodes.get(e.dst);
    const file = filePath.get(e.fileId);
    const endpoint = dst?.kind === "endpoint" ? endpointKeyOfNode(dst) : undefined;
    if (!file || !endpoint) continue;
    const evidence = Array.isArray(e.evidence) ? e.evidence : [];
    for (const ev of evidence) {
      const line = typeof ev === "string" ? Number(ev.slice(ev.lastIndexOf(":") + 1)) : Number.NaN;
      if (!Number.isInteger(line)) continue;
      const key = siteKey(repo, file, line, `${repo}:${endpoint}`);
      links.set(key, links.get(key) === "high" || e.confidence === "high" ? "high" : e.confidence);
    }
  }
  return [...links].map(([key, confidence]) => ({ key, confidence }));
}

export interface LinkingScore {
  case: string;
  bar: { recall: number; precision: number };
  repos: { name: string; sha: string }[];
  requests: {
    labelled: number;
    predicted: number;
    matched: number;
    precision: number;
    recall: number;
    wrongHigh: number;
    pass: boolean;
  };
  missed: string[];
  extra: string[];
  pass: boolean;
}

/** `dumps` is one `index --dump` per repo of the case. Labelled sites are the non-null ones. */
export function scoreLinking(labels: LinkingLabels, dumps: Record<string, Dump>): LinkingScore {
  const labelled = new Set(
    labels.requests
      .filter((s): s is Site & { expect: NonNullable<Site["expect"]> } => s.expect !== null)
      .map(labelKey),
  );
  const links = new Map<string, string>();
  for (const [repo, dump] of Object.entries(dumps))
    for (const l of linkSites(repo, dump)) links.set(l.key, l.confidence);
  const predicted = new Set(links.keys());
  const matched = [...predicted].filter((k) => labelled.has(k)).length;
  const precision = predicted.size === 0 ? 1 : matched / predicted.size;
  const recall = labelled.size === 0 ? 1 : matched / labelled.size;
  const wrongHigh = [...links].filter(([k, c]) => c === "high" && !labelled.has(k)).length;
  const pass = recall >= BAR.recall && precision >= BAR.precision && wrongHigh === 0;
  return {
    case: labels.case,
    bar: { recall: BAR.recall, precision: BAR.precision },
    repos: labels.repos,
    requests: {
      labelled: labelled.size,
      predicted: predicted.size,
      matched,
      precision: round4(precision),
      recall: round4(recall),
      wrongHigh,
      pass,
    },
    missed: [...labelled].filter((k) => !predicted.has(k)).sort(),
    extra: [...predicted].filter((k) => !labelled.has(k)).sort(),
    pass,
  };
}

/** Runs the built CLI over each repo of the case and scores the links. */
export function runLinkingCase(
  labels: LinkingLabels,
  repos: Repo[],
  dumpTexts?: Record<string, string>,
): LinkingScore {
  const dumps: Record<string, Dump> = {};
  for (const repo of repos) {
    const text = dumpTexts?.[repo.name] ?? runDump(requireCloneAndBuild(repo));
    dumps[repo.name] = parseDump(text);
  }
  return scoreLinking(labels, dumps);
}

export const cloneDirOf = (repos: Repo[]) => (name: string) => {
  const repo = repos.find((r) => r.name === name);
  if (!repo) throw new InputError(`repo ${name} is not in the case`);
  return targetDir(repo);
};

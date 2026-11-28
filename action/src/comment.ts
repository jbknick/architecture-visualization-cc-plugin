// The body of the pull request comment (issue #282). A summary built from `gantry review --json` and
// `gantry duplicates --since <base> --json`: the raw JSON is never posted. Every list has a cap, every line a
// length limit, and `buildComment` fits the whole body under `MAX_BODY` (GitHub refuses a body over 65,536
// characters), so the size is bounded whatever the input.
//
// Everything that comes from the reviewed repository (names, paths, notes) is untrusted text: it only ever appears
// inside a code span, with backticks, line breaks and table pipes neutralized, so a file name cannot add links,
// mentions, HTML or table cells to the comment.

import type { ChangeConsumers, Consumer, Impact, ReviewDiff } from "../../packages/core/src/index.js";
import { cleanUntrustedText } from "../../packages/core/src/text/untrusted.js";
import type { DupCluster, DuplicatesResult } from "../../packages/explorer/src/index.js";

/** Hidden first line of the comment; the script finds its earlier comment by it. */
export const MARKER = "<!-- gantry:pr-comment -->";
/** GitHub's limit for the body of an issue or pull request comment, in characters. */
export const GITHUB_COMMENT_LIMIT = 65_536;
/** The body is cut to fit this, which leaves room below GitHub's limit. */
export const MAX_BODY = 60_000;

/** What `gantry review <base>...<head> --json` prints (`impact` is null when there is no index). */
export type ReviewJson = ReviewDiff & { impact: Impact | null };
/** What `gantry duplicates --json` prints (the fields the comment reads). */
export type DuplicatesJson = Pick<DuplicatesResult, "summary" | "clusters">;

/**
 * One edge of `gantry team boundaries --json` (the fields of the CLI's `CrossingFinding` that the comment reads).
 * `srcLine` is 0 for an import. Group and symbol names are untrusted text.
 */
export interface CrossingFinding {
  kind: "crossing";
  srcName: string;
  srcPath: string;
  srcLine: number;
  srcGroup: string;
  dstName: string;
  dstPath: string;
  dstLine: number;
  dstGroup: string;
  team?: true;
}

export interface CommentInput {
  review: ReviewJson;
  /** Null when the duplicate check could not run; `duplicatesError` then says why. */
  duplicates: DuplicatesJson | null;
  duplicatesError?: string;
  /** Whether the head commit holds `.gantry/recipe.json`. Without it the radius is structural only. */
  hasRecipe: boolean;
  /** Whether the workflow embedded code vectors (`embed: true`), which adds the code-vector tier. */
  embed: boolean;
  version?: string;
  /** What `gantry team boundaries --json` printed, when the Action has the team values; absent or null otherwise. */
  teamBoundaries?: { crossings: CrossingFinding[]; total: number } | null;
}

/** Caps per list; the rest is counted ("and N more"), never listed. */
export const CAPS = {
  riskReasons: 8,
  changedRows: 30,
  consumerChanges: 15,
  directPerChange: 10,
  potentialPerChange: 10,
  crossings: 10,
  teamPairs: 10,
  teamItemsPerPair: 3,
  clusters: 15,
  membersPerCluster: 6,
  notes: 10,
  hubs: 3,
} as const;
const LINE_MAX = 200;
const CELL_MAX = 80;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function sanitize(text: string, max: number): string {
  return cleanUntrustedText(text, max);
}

/** Untrusted text as a code span: no backticks, no line breaks, cut to `max` characters. */
export function code(text: string, max = LINE_MAX): string {
  const t = sanitize(text, max);
  return t === "" ? "`-`" : `\`${t}\``;
}

/** `code` for a table cell: the pipe is escaped too. */
function cell(text: string): string {
  return code(text, CELL_MAX).replaceAll("|", "\\|");
}

const shortRef = (ref: string): string => (/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref);

/** The name of a node from its id: the symbol name, the file's path, or the id after its prefix. */
export function nameOfId(id: string): string {
  if (id.startsWith("sym:")) return id.slice(id.lastIndexOf("#") + 1);
  if (id.startsWith("file:")) {
    const rest = id.slice(id.indexOf(":", 5) + 1);
    return rest || id;
  }
  return id;
}

const locate = (path: string, line: number | null | undefined): string =>
  line === null || line === undefined ? path : `${path}:${line}`;

function consumerLine(c: Consumer): string {
  const via = c.via !== undefined ? ` via ${nameOfId(c.via)} (hop ${c.hop})` : "";
  const crosses = c.crosses.length > 0 ? `; crosses ${c.crosses.join(", ")}` : "";
  return `${c.name} (${c.kind}, ${locate(c.path, c.line)}) ${c.uses.join(", ")}${via}${crosses}`;
}

function kindsText(impact: Impact): string {
  const kinds = new Map<string, number>();
  for (const c of impact.changed) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
  return [...kinds.entries()]
    .sort((a, b) => cmp(a[0], b[0]))
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
}

function headerSection(input: CommentInput): string {
  const { review } = input;
  const range = `${shortRef(review.base)}...${shortRef(review.head)}`;
  const files = plural(review.files.length, "file");
  const lines = [MARKER, "## Gantry: what this pull request changes", ""];
  if (review.impact === null) {
    lines.push(
      `**No impact data**: this repository has no index, so only the ${files} in ${code(range)} are counted.`,
    );
  } else {
    const { risk } = review.impact;
    const kinds = kindsText(review.impact);
    lines.push(
      `**Risk: ${risk.level} (${risk.score}/100)** · ${files} · ${plural(review.impact.changed.length, "symbol change")}${kinds ? ` (${kinds})` : ""} · ${code(range)}`,
    );
    for (const r of risk.reasons.slice(0, CAPS.riskReasons)) lines.push(`- ${code(r)}`);
    if (risk.reasons.length > CAPS.riskReasons)
      lines.push(`- and ${risk.reasons.length - CAPS.riskReasons} more`);
  }
  if (!input.hasRecipe) {
    lines.push(
      "",
      "> **Structural radius only.** This repository has no committed `.gantry/recipe.json`, so the radius follows imports, calls and renders, and routes, endpoints and tables are not linked. A recipe lets this comment show what developers see locally.",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Added and changed ids of the review, by kind, to mark duplicate members that belong to this pull request. */
function changeKinds(review: ReviewJson): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of review.changes) if (c.kind !== "removed") out.set(c.id, c.kind);
  return out;
}

function duplicatesSection(input: CommentInput): string {
  const lines = ["### Duplicates", ""];
  if (input.duplicates === null) {
    lines.push(`The duplicate check did not run: ${code(input.duplicatesError ?? "unknown error")}`);
    return `${lines.join("\n")}\n`;
  }
  const { summary, clusters } = input.duplicates;
  if (clusters.length === 0) {
    lines.push("No duplicates in the code this pull request adds or changes.");
    return `${lines.join("\n")}\n`;
  }
  const mine = changeKinds(input.review);
  lines.push(
    `${plural(summary.clusters, "group")} with code this pull request adds or changes · ${plural(summary.functions, "function")} · ${plural(summary.duplicateLines, "duplicate line")}`,
    "",
  );
  clusters.slice(0, CAPS.clusters).forEach((c: DupCluster, i: number) => {
    const keep = c.members.find((m) => m.keep);
    lines.push(
      `${i + 1}. **${c.tier}**, ${plural(c.size, "function")}, ${plural(c.loc, "line")}${keep ? `: keep ${code(`${locate(keep.path, keep.line)} ${keep.name}`)}${flag(mine.get(keep.id))}` : ""}`,
    );
    const others = c.members.filter((m) => !m.keep);
    for (const m of others.slice(0, CAPS.membersPerCluster)) {
      const sim = `${m.tier ?? "near"}${m.score === null ? "" : ` ${m.score.toFixed(2)}`}`;
      lines.push(`   - ${code(`${locate(m.path, m.line)} ${m.name}`)} (${sim})${flag(mine.get(m.id))}`);
    }
    if (others.length > CAPS.membersPerCluster)
      lines.push(`   - and ${others.length - CAPS.membersPerCluster} more`);
  });
  if (clusters.length > CAPS.clusters)
    lines.push(`${clusters.length - CAPS.clusters} more group(s) are in \`gantry duplicates --since\`.`);
  return `${lines.join("\n")}\n`;
}

const flag = (kind: string | undefined): string =>
  kind === undefined ? "" : kind === "added" ? " **added here**" : " **changed here**";

function changedSection(review: ReviewJson): string {
  const impact = review.impact;
  if (impact === null || impact.changed.length === 0) {
    return `### Changed symbols\n\nNo indexed symbols changed in this range.\n`;
  }
  const byId = new Map<string, ChangeConsumers>(impact.consumers.map((c) => [c.id, c]));
  const lines = [
    `### Changed symbols (${impact.changed.length})`,
    "",
    "| Change | Symbol | Where | Direct | Potential |",
    "| --- | --- | --- | ---: | ---: |",
  ];
  for (const c of impact.changed.slice(0, CAPS.changedRows)) {
    const side = c.after ?? c.before;
    const cons = byId.get(c.id);
    const sig = c.signatureChanged ? " (signature)" : "";
    lines.push(
      `| ${c.kind}${sig} | ${cell(nameOfId(c.id))} | ${side ? cell(locate(side.path, side.line)) : ""} | ${cons?.directTotal ?? 0} | ${cons?.potentialTotal ?? 0} |`,
    );
  }
  if (impact.changed.length > CAPS.changedRows)
    lines.push("", `and ${impact.changed.length - CAPS.changedRows} more in \`gantry review --json\`.`);
  return `${lines.join("\n")}\n`;
}

function crossingsSection(review: ReviewJson): string {
  const crossings = review.impact?.crossings ?? [];
  if (crossings.length === 0) return "";
  const lines = [`### Crossings (${crossings.length})`, ""];
  for (const x of crossings.slice(0, CAPS.crossings))
    lines.push(`- ${x.kind}: ${code(nameOfId(x.from))} is used from ${code(nameOfId(x.to))}`);
  if (crossings.length > CAPS.crossings) lines.push(`- and ${crossings.length - CAPS.crossings} more`);
  return `${lines.join("\n")}\n`;
}

/** One place of a team crossing: the functions, or the file paths of an import (an import has no source line). */
function teamItem(f: CrossingFinding): string {
  return f.srcLine === 0
    ? `${code(f.srcPath, CELL_MAX)} uses ${code(f.dstPath, CELL_MAX)}`
    : `${code(f.srcName, CELL_MAX)} uses ${code(f.dstName, CELL_MAX)}`;
}

/**
 * Edges that break a team group's `mayUse`, by pair of groups (a separate section from `Crossings`). Group and
 * function names come from the team and the repository: they are code spans like every other name here.
 */
function teamBoundariesSection(input: CommentInput): string {
  const found = input.teamBoundaries?.crossings ?? [];
  if (found.length === 0) return "";
  const pairs = new Map<string, { src: string; dst: string; items: CrossingFinding[] }>();
  for (const f of found) {
    const key = `${f.srcGroup}\0${f.dstGroup}`;
    const pair = pairs.get(key) ?? { src: f.srcGroup, dst: f.dstGroup, items: [] };
    pair.items.push(f);
    pairs.set(key, pair);
  }
  const sorted = [...pairs.values()].sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst));
  const lines = [`### Team boundaries (${sorted.length})`, ""];
  for (const p of sorted.slice(0, CAPS.teamPairs)) {
    const shown = p.items.slice(0, CAPS.teamItemsPerPair).map(teamItem).join(", ");
    lines.push(
      `- ${code(p.src, CELL_MAX)} → ${code(p.dst, CELL_MAX)}: ${shown} (${plural(p.items.length, "edge")} in total)`,
    );
  }
  if (sorted.length > CAPS.teamPairs) lines.push(`- and ${sorted.length - CAPS.teamPairs} more`);
  return `${lines.join("\n")}\n`;
}

function consumersSection(review: ReviewJson): string {
  const used = (review.impact?.consumers ?? []).filter(
    (c) => c.directTotal + c.potentialTotal + c.reachableTotal > 0,
  );
  if (used.length === 0) return "";
  const lines = ["### Consumers", ""];
  const impact = review.impact;
  if (impact && impact.reachable.total > 0) lines.push(`Reachable (4+ hops): ${impact.reachable.total}`, "");
  if (impact && impact.hubs.length > 0) {
    const shown = impact.hubs
      .slice(0, CAPS.hubs)
      .map((h) => `${code(nameOfId(h.hub), CELL_MAX)} (${h.consumersTotal})`);
    const more = impact.hubs.length - CAPS.hubs;
    lines.push(`Hubs: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`, "");
  }
  for (const c of used.slice(0, CAPS.consumerChanges)) {
    lines.push(
      "<details>",
      `<summary>${code(nameOfId(c.id), CELL_MAX)}: ${c.directTotal} direct, ${c.potentialTotal} potential</summary>`,
      "",
    );
    if (c.directTotal > 0) {
      lines.push(`Directly affected (${c.directTotal}):`, "");
      for (const d of c.direct.slice(0, CAPS.directPerChange)) lines.push(`- ${code(consumerLine(d))}`);
      if (c.directTotal > CAPS.directPerChange)
        lines.push(`- and ${c.directTotal - CAPS.directPerChange} more`);
      lines.push("");
    }
    if (c.potentialTotal > 0) {
      lines.push(`Potentially affected (${c.potentialTotal}):`, "");
      for (const p of c.potential.slice(0, CAPS.potentialPerChange)) lines.push(`- ${code(consumerLine(p))}`);
      if (c.potentialTotal > CAPS.potentialPerChange)
        lines.push(`- and ${c.potentialTotal - CAPS.potentialPerChange} more`);
      lines.push("");
    }
    lines.push("</details>", "");
  }
  if (used.length > CAPS.consumerChanges)
    lines.push(
      `Consumers of ${used.length - CAPS.consumerChanges} more change(s) are in \`gantry review --json\`.`,
    );
  return `${lines.join("\n").trimEnd()}\n`;
}

const isDuplicateNote = (n: string): boolean => /^New function .* duplicates /.test(n);

function notesSection(input: CommentInput): string {
  const all = (input.review.impact?.notes ?? []).filter(
    // The Duplicates section says the same with more detail, when the duplicate check ran.
    (n) => input.duplicates === null || !isDuplicateNote(n),
  );
  if (all.length === 0) return "";
  const lines = ["### Notes", ""];
  for (const n of all.slice(0, CAPS.notes)) lines.push(`- ${code(n, 300)}`);
  if (all.length > CAPS.notes) lines.push(`- and ${all.length - CAPS.notes} more`);
  return `${lines.join("\n")}\n`;
}

function footerSection(input: CommentInput): string {
  const tiers = input.embed ? "exact, near and code-vector" : "exact and near";
  const v = input.version ? `Gantry ${sanitize(input.version, 20)} · ` : "Gantry · ";
  return `<sub>${v}duplicate tiers: ${tiers} · no model calls · updated for ${shortRef(sanitize(input.review.head, 60))}</sub>\n`;
}

/**
 * The comment when the analysis could not run (issue #282, fail open): the same marker as the full comment, so the
 * earlier comment is updated in place, and one bounded line saying why. `reason` is untrusted text. The same text is
 * built by `action/post-failure.sh` when the install failed and this script is not there; a test keeps them equal.
 */
export function buildFailureComment(reason: string): string {
  return [
    MARKER,
    "## Gantry: the analysis failed",
    "",
    `Gantry could not analyze this pull request: ${code(reason, FAILURE_MAX)}`,
    "",
    "<sub>The pull request itself is not affected. The job log of the Gantry step has the details.</sub>",
    "",
  ].join("\n");
}
/** Longest reason in the failure comment, in characters. */
export const FAILURE_MAX = 200;

const OMITTED = "\n_Part of this comment was left out to stay under GitHub's comment size limit._\n";

/**
 * The comment body: a hidden marker, then risk, duplicates, changed symbols, crossings, team boundaries, consumers, notes and a footer.
 * Never longer than `MAX_BODY` characters: when the sections together are too long, the least important are dropped
 * first (consumers, notes, team boundaries, crossings, then the changed-symbol table) and a last resort cuts the text.
 */
export function buildComment(input: CommentInput, limit = MAX_BODY): string {
  const sections = {
    header: headerSection(input),
    duplicates: duplicatesSection(input),
    changed: changedSection(input.review),
    crossings: crossingsSection(input.review),
    teamBoundaries: teamBoundariesSection(input),
    consumers: consumersSection(input.review),
    notes: notesSection(input),
    footer: footerSection(input),
  };
  const order = [
    "header",
    "duplicates",
    "changed",
    "crossings",
    "teamBoundaries",
    "consumers",
    "notes",
    "footer",
  ] as const;
  const dropOrder = ["consumers", "notes", "teamBoundaries", "crossings", "changed"] as const;
  const join = (): string =>
    order
      .map((k) => sections[k])
      .filter((s) => s !== "")
      .join("\n");
  let body = join();
  let omitted = false;
  for (const k of dropOrder) {
    if (body.length <= limit) break;
    sections[k] = "";
    omitted = true;
    body = join();
  }
  if (omitted) body = `${body.trimEnd()}\n${OMITTED}`;
  if (body.length > limit) {
    const keep = limit - OMITTED.length;
    body = `${body.slice(0, keep).replace(/[\ud800-\udbff]$/, "")}${OMITTED}`;
  }
  return body;
}

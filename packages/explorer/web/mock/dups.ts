// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are the source text of synthetic functions
// Mock-only duplicates view. Entirely synthetic and deterministic.
//   `#/duplicates`                  two groups shaped like the pnpm-turbo fixture's (slugify, formatRelativeDate)
//   `#/duplicates?scenario=dups`    22 groups over 7 workspaces, shaped like a real monorepo's result
// Response shapes mirror the real server (packages/explorer/server/views/duplicates.ts).
import type {
  DupCluster,
  DuplicatesData,
  DupMember,
  DupSplit,
  DupTier,
  DupWorkspace,
  GraphNode,
  ViewData,
} from "../src/api.ts";

interface WsDef {
  key: string;
  name: string;
  kind: "app" | "package";
}

const BIG_WS: WsDef[] = [
  { key: "web", name: "@acme/web", kind: "app" },
  { key: "admin", name: "@acme/admin", kind: "app" },
  { key: "api", name: "@acme/api", kind: "app" },
  { key: "ui", name: "@acme/ui", kind: "package" },
  { key: "utils", name: "@acme/utils", kind: "package" },
  { key: "auth", name: "@acme/auth", kind: "package" },
  { key: "db", name: "@acme/db", kind: "package" },
];
const DIR: Record<string, string> = {
  web: "apps/web/src",
  admin: "apps/admin/src",
  api: "apps/api/src",
  ui: "packages/ui/src",
  utils: "packages/utils/src",
  auth: "packages/auth/src",
  db: "packages/db/src",
};

const wsId = (name: string): string => `ws:${name}`;

type Lines = string[];

interface Template {
  file: string;
  /** `{n}` is replaced by the function name. */
  lines: Lines;
  /** Edits for the near copies: line index -> replacement. Two variants, used in turn. */
  alt: [Record<number, string>, Record<number, string>];
}

const TEMPLATES: Record<string, Template> = {
  duration: {
    file: "format",
    lines: [
      "export function {n}(ms: number): string {",
      "  const total = Math.floor(ms / 1000);",
      "  const hours = Math.floor(total / 3600);",
      "  const minutes = Math.floor((total % 3600) / 60);",
      "  const seconds = total % 60;",
      "  if (hours > 0) return `${hours}h ${minutes}m`;",
      "  if (minutes > 0) return `${minutes}m ${seconds}s`;",
      "  return `${seconds}s`;",
      "}",
    ],
    alt: [
      { 1: "  const total = Math.round(ms / 1000);" },
      {
        5: '  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;',
        7: "  return `${seconds} s`;",
      },
    ],
  },
  slug: {
    file: "slug",
    lines: [
      "export function {n}(input: string): string {",
      "  return input",
      "    .toLowerCase()",
      '    .normalize("NFKD")',
      '    .replace(/[^a-z0-9]+/g, "-")',
      '    .replace(/^-+|-+$/g, "");',
      "}",
    ],
    alt: [
      { 4: '    .replace(/[^a-z0-9\\s]+/g, "")\n    .replace(/\\s+/g, "-")' },
      { 2: "    .trim()\n    .toLowerCase()" },
    ],
  },
  clamp: {
    file: "math",
    lines: [
      "export function {n}(value: number, min: number, max: number): number {",
      "  if (Number.isNaN(value)) return min;",
      "  if (min > max) [min, max] = [max, min];",
      "  if (value < min) return min;",
      "  if (value > max) return max;",
      "  return value;",
      "}",
    ],
    alt: [
      { 1: "  if (!Number.isFinite(value)) return min;" },
      { 2: "  if (min > max) return clamp(value, max, min);" },
    ],
  },
  groupBy: {
    file: "collections",
    lines: [
      "export function {n}<T, K extends string | number>(items: T[], key: (item: T) => K): Record<K, T[]> {",
      "  const out = {} as Record<K, T[]>;",
      "  for (const item of items) {",
      "    const k = key(item);",
      "    (out[k] ??= []).push(item);",
      "  }",
      "  return out;",
      "}",
    ],
    alt: [
      { 1: "  const out: Record<K, T[]> = Object.create(null);" },
      { 4: "    if (!out[k]) out[k] = [];\n    out[k].push(item);" },
    ],
  },
  bytes: {
    file: "bytes",
    lines: [
      "export function {n}(bytes: number, digits = 1): string {",
      "  if (bytes < 1024) return `${bytes} B`;",
      '  const units = ["KB", "MB", "GB", "TB"];',
      "  let value = bytes / 1024;",
      "  let unit = 0;",
      "  while (value >= 1024 && unit < units.length - 1) {",
      "    value /= 1024;",
      "    unit += 1;",
      "  }",
      "  return `${value.toFixed(digits)} ${units[unit]}`;",
      "}",
    ],
    alt: [
      { 1: '  if (bytes <= 0) return "0 B";' },
      { 9: "  return `${Number(value.toFixed(digits))} ${units[unit]}`;" },
    ],
  },
  retry: {
    file: "retry",
    lines: [
      "export async function {n}<T>(run: () => Promise<T>, attempts = 3, delayMs = 200): Promise<T> {",
      "  let lastError: unknown;",
      "  for (let i = 0; i < attempts; i++) {",
      "    try {",
      "      return await run();",
      "    } catch (error) {",
      "      lastError = error;",
      "      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** i));",
      "    }",
      "  }",
      "  throw lastError;",
      "}",
    ],
    alt: [
      { 7: "      await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));" },
      { 6: "      lastError = error instanceof Error ? error : new Error(String(error));" },
    ],
  },
  truncate: {
    file: "text",
    lines: [
      "export function {n}(text: string, max: number): string {",
      "  if (text.length <= max) return text;",
      "  const cut = text.slice(0, Math.max(0, max - 1));",
      '  const lastSpace = cut.lastIndexOf(" ");',
      "  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;",
      "  return `${base.trimEnd()}…`;",
      "}",
    ],
    alt: [
      { 4: "  const base = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;" },
      { 5: '  return base.trimEnd() + "...";' },
    ],
  },
  query: {
    file: "url",
    lines: [
      "export function {n}(search: string): Record<string, string> {",
      '  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);',
      "  const out: Record<string, string> = {};",
      "  for (const [key, value] of params) {",
      "    if (key in out) continue;",
      "    out[key] = value;",
      "  }",
      "  return out;",
      "}",
    ],
    alt: [
      { 4: "    if (Object.hasOwn(out, key)) continue;" },
      { 1: '  const params = new URLSearchParams(search.replace(/^\\?/, ""));' },
    ],
  },
  chunk: {
    file: "collections",
    lines: [
      "export function {n}<T>(items: T[], size: number): T[][] {",
      '  if (size < 1) throw new Error("size must be at least 1");',
      "  const out: T[][] = [];",
      "  for (let i = 0; i < items.length; i += size) {",
      "    out.push(items.slice(i, i + size));",
      "  }",
      "  return out;",
      "}",
    ],
    alt: [
      { 1: '  if (!(size >= 1)) throw new RangeError("size must be positive");' },
      { 3: "  for (let i = 0; i < items.length; i = i + size) {" },
    ],
  },
  fxSlug: {
    file: "slug",
    lines: [
      "export function {n}(input: string): string {",
      "  const lower = input.toLowerCase();",
      "  const trimmed = lower.trim();",
      '  const dashed = trimmed.replace(/\\s+/g, "-");',
      '  const clean = dashed.replace(/[^a-z0-9-]/g, "");',
      '  const collapsed = clean.replace(/-+/g, "-");',
      '  return collapsed.replace(/^-|-$/g, "");',
      "}",
    ],
    alt: [{}, {}],
  },
  fxRelDate: {
    file: "date",
    lines: [
      "export function {n}(date: Date, now: Date = new Date()): string {",
      "  const diffMs = now.getTime() - date.getTime();",
      "  const seconds = Math.floor(diffMs / 1000);",
      "  const minutes = Math.floor(seconds / 60);",
      "  const hours = Math.floor(minutes / 60);",
      "  const days = Math.floor(hours / 24);",
      "  if (days > 0) return `${days}d ago`;",
      "  if (hours > 0) return `${hours}h ago`;",
      "  if (minutes > 0) return `${minutes}m ago`;",
      '  return "just now";',
      "}",
    ],
    alt: [
      {},
      {
        0: "export function {n}(value: Date, current: Date = new Date()): string {",
        1: "  const delta = current.getTime() - value.getTime();",
        2: "  const secs = Math.floor(delta / 1000);",
        3: "  const mins = Math.floor(secs / 60);",
        4: "  const hrs = Math.floor(mins / 60);",
        5: "  const dys = Math.floor(hrs / 24);",
        6: "  if (dys > 0) return `${dys}d ago`;",
        7: "  if (hrs > 0) return `${hrs}h ago`;",
        8: "  if (mins > 0) return `${mins}m ago`;",
      },
    ],
  },
  isEmail: {
    file: "validate",
    lines: [
      "export function {n}(value: string): boolean {",
      "  const trimmed = value.trim();",
      "  if (trimmed.length === 0 || trimmed.length > 254) return false;",
      '  const at = trimmed.indexOf("@");',
      '  if (at < 1 || at !== trimmed.lastIndexOf("@")) return false;',
      "  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(trimmed);",
      "}",
    ],
    alt: [
      { 2: "  if (!trimmed || trimmed.length > 320) return false;" },
      { 5: "  return /^[\\w.+-]+@[\\w-]+\\.[\\w.-]+$/.test(trimmed);" },
    ],
  },
};

/** name, workspace key, exported, callers */
type Row = [name: string, ws: string, exported: boolean, callers: number];
interface Spec {
  tpl: keyof typeof TEMPLATES;
  tier: DupTier;
  rows: Row[];
}

const BIG_SPECS: Spec[] = [
  {
    tpl: "duration",
    tier: "near",
    rows: [
      ["formatDuration", "ui", true, 14],
      ["humanizeMs", "web", false, 3],
      ["prettyElapsed", "admin", false, 2],
      ["durationLabel", "api", true, 1],
    ],
  },
  {
    tpl: "slug",
    tier: "exact",
    rows: [
      ["slugify", "utils", false, 6],
      ["slugify", "web", true, 5],
      ["toSlug", "admin", false, 2],
    ],
  },
  {
    tpl: "bytes",
    tier: "near",
    rows: [
      ["formatBytes", "utils", true, 9],
      ["fileSizeLabel", "admin", false, 4],
      ["prettySize", "web", false, 2],
    ],
  },
  {
    tpl: "retry",
    tier: "near",
    rows: [
      ["withRetry", "utils", true, 7],
      ["retryRequest", "api", false, 5],
      ["tryAgain", "auth", false, 1],
    ],
  },
  {
    tpl: "groupBy",
    tier: "exact",
    rows: [
      ["groupBy", "utils", true, 11],
      ["bucketBy", "utils", false, 3],
    ],
  },
  {
    tpl: "clamp",
    tier: "near",
    rows: [
      ["clamp", "ui", true, 12],
      ["limitRange", "web", false, 2],
      ["constrain", "admin", false, 1],
    ],
  },
  {
    tpl: "truncate",
    tier: "near",
    rows: [
      ["truncate", "ui", true, 8],
      ["ellipsize", "ui", false, 4],
    ],
  },
  {
    tpl: "query",
    tier: "near",
    rows: [
      ["parseQuery", "web", true, 6],
      ["readSearchParams", "admin", true, 4],
      ["queryToObject", "api", false, 2],
    ],
  },
  {
    tpl: "chunk",
    tier: "exact",
    rows: [
      ["chunk", "utils", true, 5],
      ["splitIntoPages", "api", false, 1],
      ["batchItems", "db", false, 2],
    ],
  },
  {
    tpl: "isEmail",
    tier: "near",
    rows: [
      ["isEmail", "auth", true, 6],
      ["looksLikeEmail", "web", false, 2],
    ],
  },
  {
    tpl: "duration",
    tier: "near",
    rows: [
      ["formatElapsed", "db", false, 2],
      ["timeAgoShort", "web", false, 3],
    ],
  },
  {
    tpl: "slug",
    tier: "near",
    rows: [
      ["makeSlug", "admin", false, 1],
      ["urlSafe", "api", false, 2],
    ],
  },
  {
    tpl: "clamp",
    tier: "near",
    rows: [
      ["clampPercent", "admin", false, 3],
      ["boundPercent", "admin", false, 2],
      ["pinToRange", "admin", false, 1],
    ],
  },
  {
    tpl: "groupBy",
    tier: "near",
    rows: [
      ["indexByKey", "db", false, 2],
      ["groupRows", "api", false, 4],
    ],
  },
  {
    tpl: "bytes",
    tier: "exact",
    rows: [
      ["formatBytes", "web", false, 3],
      ["byteLabel", "web", false, 2],
    ],
  },
  {
    tpl: "truncate",
    tier: "near",
    rows: [
      ["shorten", "admin", false, 2],
      ["clipText", "api", false, 1],
    ],
  },
  {
    tpl: "retry",
    tier: "near",
    rows: [
      ["retryQuery", "db", false, 3],
      ["retryLogin", "auth", false, 2],
    ],
  },
  {
    tpl: "query",
    tier: "near",
    rows: [
      ["parseSearch", "ui", false, 1],
      ["readQuery", "ui", false, 1],
    ],
  },
  {
    tpl: "chunk",
    tier: "near",
    rows: [
      ["paginate", "web", false, 2],
      ["toBatches", "web", false, 1],
    ],
  },
  {
    tpl: "isEmail",
    tier: "exact",
    rows: [
      ["validEmail", "admin", false, 2],
      ["validEmail", "api", false, 2],
    ],
  },
  {
    tpl: "clamp",
    tier: "near",
    rows: [
      ["limit", "db", false, 1],
      ["capValue", "db", false, 1],
    ],
  },
  {
    tpl: "truncate",
    tier: "near",
    rows: [
      ["abbreviate", "db", false, 1],
      ["cutText", "auth", false, 1],
    ],
  },
];

const SMALL_SPECS: Spec[] = [
  {
    tpl: "fxSlug",
    tier: "exact",
    rows: [
      ["slugify", "utils", false, 1],
      ["slugify", "web", true, 1],
    ],
  },
  {
    tpl: "fxRelDate",
    tier: "near",
    rows: [
      ["formatRelativeDate", "utils", true, 1],
      ["parseTimestamp", "utils", true, 0],
    ],
  },
];

interface Built {
  clusters: DupCluster[];
  workspaces: DupWorkspace[];
}

function bodyOf(spec: Spec, row: Row, index: number): Lines {
  const t = TEMPLATES[spec.tpl] as Template;
  let lines = t.lines.map((l) => l.replace("{n}", row[0]));
  if (index > 0 && spec.tier !== "exact") {
    const alt = t.alt[index % 2] as Record<number, string>;
    lines = lines.map((l, i) => (alt[i] ?? l).replace("{n}", row[0]));
    // Some copies change a second line too.
    if (index > 1)
      lines = lines.map((l, i) =>
        ((t.alt[(index + 1) % 2] as Record<number, string>)[i] ?? l).replace("{n}", row[0]),
      );
    lines = lines.join("\n").split("\n");
  }
  return lines;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function symbolPath(spec: Spec, row: Row, dirs: Record<string, string>): string {
  const t = TEMPLATES[spec.tpl] as Template;
  return `${dirs[row[1]] ?? "src"}/${t.file}.ts`;
}

const sources = new Map<string, Lines>();
/** Pair keys ("a\nb") hidden by "Not a duplicate". */
const dismissedPairs = new Set<string>();

function build(specs: Spec[], wsDefs: WsDef[], dirs: Record<string, string>): Built {
  const wsByKey = new Map(wsDefs.map((w) => [w.key, w]));
  const workspaces: DupWorkspace[] = wsDefs
    .map((w) => ({
      id: wsId(w.name),
      name: w.name,
      shortLabel: w.name.replace("@acme/", ""),
      kind: w.kind,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const clusters: DupCluster[] = [];
  for (const spec of specs) {
    const members: DupMember[] = spec.rows.map((row, i) => {
      const path = symbolPath(spec, row, dirs);
      const lines = bodyOf(spec, row, i);
      const line = 8 + i * 9;
      const id = `sym:${path}#${row[0]}`;
      sources.set(`${path}:${line}`, lines);
      const ws = wsByKey.get(row[1]) as WsDef;
      return {
        id,
        name: row[0],
        kind: "function",
        path,
        line,
        endLine: line + lines.length - 1,
        loc: lines.length,
        workspaceId: wsId(ws.name),
        exported: row[2],
        fanIn: row[3],
        tier: spec.tier,
        score: spec.tier === "exact" ? 1 : round3(0.97 - i * 0.04),
        keep: false,
      };
    });
    const wsKind = (m: DupMember) => workspaces.find((w) => w.id === m.workspaceId)?.kind;
    const rank = (m: DupMember) => (wsKind(m) === "package" ? 2 : 0) + (m.exported ? 1 : 0);
    const keep = [...members].sort(
      (a, b) =>
        rank(b) - rank(a) || b.fanIn - a.fanIn || (a.path < b.path ? -1 : 1) || (a.id < b.id ? -1 : 1),
    )[0] as DupMember;
    keep.keep = true;
    keep.tier = null;
    keep.score = 1;
    members.sort((a, b) => (a === keep ? -1 : b === keep ? 1 : a.path < b.path ? -1 : 1));
    const ws = workspaces.find((w) => w.id === keep.workspaceId);
    const parts = [
      ws?.kind === "package" ? `in the shared package ${ws.name}` : `in ${ws?.name ?? "its workspace"}`,
      keep.exported ? "exported" : "not exported yet",
      keep.fanIn === 1 ? "called by 1 function" : `called by ${keep.fanIn} functions`,
    ].join(", ");
    const others = members.length > 2 ? `the other ${members.length - 1} copies` : "the other copy";
    const loc = members.reduce((s, m) => s + m.loc, 0);
    const ids = members.map((m) => m.id).sort();
    clusters.push({
      id: `cluster:${ids[0]}`,
      tier: spec.tier,
      tiers: {
        exact: spec.tier === "exact" ? members.length - 1 : 0,
        near: spec.tier === "near" ? members.length - 1 : 0,
        code_vector: 0,
        semantic: 0,
      },
      size: members.length,
      loc,
      rank: members.length * loc,
      keep: keep.id,
      keepReason: `${parts.charAt(0).toUpperCase()}${parts.slice(1)}; ${others} can use it.`,
      workspaces: [...new Set(members.map((m) => m.workspaceId as string))].sort(),
      members,
      links: members
        .filter((m) => !m.keep)
        .map((m) => {
          const [a, b] = m.id < keep.id ? [m.id, keep.id] : [keep.id, m.id];
          return { a, b, tier: spec.tier };
        }),
    });
  }
  return { clusters, workspaces };
}

let bigBuilt: Built | undefined;
let smallBuilt: Built | undefined;
const SMALL_WS: WsDef[] = [
  { key: "utils", name: "@acme/utils", kind: "package" },
  { key: "web", name: "@acme/web", kind: "app" },
];
const SMALL_DIR: Record<string, string> = { utils: "packages/utils/src", web: "apps/web/src/lib" };

function viewOf(built: Built, skippedMessage: string): ViewData {
  // Dismissals remove a copy from its group; a group below two copies disappears.
  const clusters: DupCluster[] = [];
  for (const c of built.clusters) {
    const members = c.members.filter(
      (m) =>
        m.keep || (!dismissedPairs.has(pairKey(c.keep, m.id)) && !dismissedPairs.has(pairKey(m.id, c.keep))),
    );
    if (members.length < 2) continue;
    const loc = members.reduce((s, m) => s + m.loc, 0);
    const keptIds = new Set(members.map((m) => m.id));
    clusters.push({
      ...c,
      members,
      size: members.length,
      loc,
      rank: members.length * loc,
      links: c.links.filter((l) => keptIds.has(l.a) && keptIds.has(l.b)),
      workspaces: [...new Set(members.map((m) => m.workspaceId as string))].sort(),
    });
  }
  clusters.sort((a, b) => b.rank - a.rank || b.size - a.size || (a.id < b.id ? -1 : 1));
  const splitMap = new Map<string, DupSplit>();
  let duplicateLines = 0;
  let functions = 0;
  let cross = 0;
  for (const c of clusters) {
    functions += c.size;
    duplicateLines += c.members.filter((m) => !m.keep).reduce((s, m) => s + m.loc, 0);
    if (c.workspaces.length > 1) cross += 1;
    const key = c.workspaces.join("|");
    const s = splitMap.get(key) ?? { workspaces: c.workspaces, clusters: 0, functions: 0 };
    s.clusters += 1;
    s.functions += c.size;
    splitMap.set(key, s);
  }
  const nodes: GraphNode[] = clusters.flatMap((c) =>
    c.members.map((m) => ({
      id: m.id,
      kind: m.kind,
      label: m.name,
      size: m.loc,
      path: m.path,
      workspace: m.workspaceId ?? undefined,
    })),
  );
  const data: DuplicatesData = {
    clusters,
    summary: { clusters: clusters.length, functions, duplicateLines, crossWorkspace: cross },
    splits: [...splitMap.values()].sort(
      (a, b) => b.clusters - a.clusters || (a.workspaces.join() < b.workspaces.join() ? -1 : 1),
    ),
    workspaces: built.workspaces,
    skipped: [{ tier: "code_vector", reason: "not_embedded", message: skippedMessage }],
  };
  return { nodes, edges: [], layoutHint: "clusters", ...data };
}

const pairKey = (a: string, b: string): string => `${a}\n${b}`;

const EMBED_HINT = "Run gantry embed to also find renamed copies.";

/** `/api/view/duplicates` for the mock. `scenario=dups` serves the large dataset. */
export function duplicatesView(options: Record<string, unknown>): ViewData {
  const tiers = typeof options.tiers === "string" ? options.tiers.split("|") : null;
  const large = options.scenario === "dups";
  if (large) bigBuilt ??= build(BIG_SPECS, BIG_WS, DIR);
  else smallBuilt ??= build(SMALL_SPECS, SMALL_WS, SMALL_DIR);
  const built = (large ? bigBuilt : smallBuilt) as Built;
  const view = viewOf(built, EMBED_HINT);
  if (tiers) {
    const keepTiers = new Set(tiers);
    view.clusters = (view.clusters ?? []).filter((c) => keepTiers.has(c.tier));
    const s = view.summary;
    if (s) {
      s.clusters = view.clusters.length;
    }
  }
  return view;
}

/** `/api/source` for the mock's duplicate members: the lines of the function that starts at `start`. */
export function duplicatesSource(path: string, start: number): { lines: Lines } | null {
  const lines = sources.get(`${path}:${start}`);
  if (!lines) {
    // Build lazily when a source is asked before the view (page reload on a deep link).
    duplicatesView({ scenario: "dups" });
    duplicatesView({});
    const again = sources.get(`${path}:${start}`);
    return again ? { lines: again } : null;
  }
  return { lines };
}

/** `PUT /api/dismiss` for the mock. */
export function duplicatesDismiss(body: unknown): { status: number; body: unknown } {
  const o = (body ?? {}) as { a?: unknown; b?: unknown; reason?: unknown };
  if (typeof o.a !== "string" || typeof o.b !== "string" || o.a === o.b) {
    return { status: 400, body: { error: "a and b must be different symbol ids" } };
  }
  dismissedPairs.add(pairKey(o.a, o.b));
  dismissedPairs.add(pairKey(o.b, o.a));
  const view = duplicatesView(currentScenario);
  return {
    status: 200,
    body: {
      dismissed: { a: o.a, b: o.b, reason: typeof o.reason === "string" ? o.reason : "" },
      summary: view.summary,
      clusters: (view.clusters ?? []).map((c) => ({ id: c.id, size: c.size })),
    },
  };
}

let currentScenario: Record<string, unknown> = {};
export function rememberScenario(options: Record<string, unknown>): void {
  currentScenario = options.scenario === "dups" ? { scenario: "dups" } : {};
}

export function resetDuplicatesMock(): void {
  dismissedPairs.clear();
}

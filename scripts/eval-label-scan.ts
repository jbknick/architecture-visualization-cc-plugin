// Candidate-site scan and sample of hand labels for the TypeScript framework cases (#268, spec section 13).
// Re-runs, by stack, the greps a labeller used to find registration sites, and reports every hit that no label
// covers and the README does not list. No network, no scoring.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { lastLiteralSegment, sameTable } from "./eval-label-check.js";
import { type EndpointLabel, endpointKey, type Labels, type Repo } from "./eval-lib.js";

// The data-access cases (#269) use the same scan: for a repo whose stack names an ORM or client, the table
// definitions and the data-access calls found below are candidates too, and the table, read and write labels cover
// them (see "Data-access patterns" further down).

export interface Candidate {
  file: string;
  line: number;
  /** `call` is a registration call, `file` a file that is a route by its place, `rpc` and `fn` carry a name,
   * `data` a table definition or a data-access call (`text` says what is missing). */
  kind: "call" | "file" | "rpc" | "fn" | "data";
  name?: string;
  text: string;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".output",
  "__tests__",
  "__mocks__",
  "test",
  "tests",
  "e2e",
  "fixtures",
  "migrations",
]);
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP_FILE = /\.(?:test|spec|stories|d)\.[cm]?[jt]sx?$|\.gen\.ts$/;

/** Source files of a clone as repo-relative posix paths, without tests, build output and vendored code. */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(p);
      } else if (CODE.test(name) && !SKIP_FILE.test(name)) out.push(relative(dir, p).split("\\").join("/"));
    }
  };
  walk(dir);
  return out;
}

const VERB_CALL = /\.(get|post|put|patch|delete|all|options|head|route|on|doc)\(/;
const NEST = /^\s*@(Get|Post|Put|Patch|Delete|All|Options|Head)\(/;
const RR =
  /<Route\b|\b(?:route|index|layout|prefix)\(\s*["'`[]|create(?:Browser|Hash|Memory)Router\(|^\s*path:\s*["'`]/;
const NEXT_FILE =
  /(?:^|\/)app\/(?:.*\/)?(?:page|route)\.[jt]sx?$|(?:^|\/)pages\/(?!_app\.|_document\.).*\.[jt]sx?$/;
const TANSTACK_ROUTE = /\bcreateFileRoute\(/;
const SERVER_FN = /\bconst\s+(\w+)\s*=\s*createServerFn\(/;
const PROCEDURE = /^\s*(\w+):\s*\w*[Pp]rocedure\b/;

/** Every candidate registration site of a repo, found by the stack's patterns (the labeller's `rg` lines). */
export function candidates(dir: string, stack: string[]): Candidate[] {
  const has = (...s: string[]) => s.some((x) => stack.includes(x));
  const out: Candidate[] = [];
  for (const file of sourceFiles(dir)) {
    if (has("nextjs") && NEXT_FILE.test(file)) out.push({ file, line: 1, kind: "file", text: file });
    const lines = readFileSync(join(dir, file), "utf8").split("\n");
    lines.forEach((text, i) => {
      const line = i + 1;
      const add = (c: Omit<Candidate, "file" | "line" | "text">) =>
        out.push({ file, line, text: text.trim(), ...c });
      if (has("express", "fastify", "hono") && (VERB_CALL.test(text) || /\bcreateRoute\(/.test(text)))
        add({ kind: "call" });
      if (has("nestjs") && NEST.test(text)) add({ kind: "call" });
      if (has("react-router") && RR.test(text)) add({ kind: "call" });
      if (has("tanstack-start", "tanstack-router") && TANSTACK_ROUTE.test(text)) add({ kind: "file" });
      const fn = has("tanstack-start") ? SERVER_FN.exec(text) : null;
      if (fn) add({ kind: "fn", name: fn[1] as string });
      const rpc = has("orpc") ? PROCEDURE.exec(text) : null;
      if (rpc) add({ kind: "rpc", name: rpc[1] as string });
    });
  }
  return out;
}

const refLine = (ref: string) => Number(ref.slice(ref.lastIndexOf(":") + 1));
const refFile = (ref: string) => ref.slice(0, ref.lastIndexOf(":"));

/** Whether a label accounts for a candidate. A call is covered by an endpoint registration on its line, or on one of
 * the next two when the call is still open there (`router.get(\n "/x",`), or by an endpoint label of that file
 * without a registration; a file by a route or endpoint label naming it; an rpc or fn by its name. */
export function covers(labels: Labels, c: Candidate): boolean {
  const eps = labels.endpoint;
  if (c.kind === "rpc")
    return eps.some(
      (e) => "rpc" in e && e.file === c.file && (e.rpc === c.name || e.rpc.endsWith(`.${c.name}`)),
    );
  if (c.kind === "fn") return eps.some((e) => "fn" in e && e.file === c.file && e.fn === c.name);
  if (c.kind === "file")
    return labels.route.some((r) => r.file === c.file) || eps.some((e) => e.file === c.file);
  // A route call (`<Route path="/x">`, `index(...)`, `path: "x"`) is covered by a route label of its file that its
  // text names: the last literal segment of the path, or an `index(` call for `/`.
  const text = c.text.toLowerCase();
  if (
    labels.route.some((r) => {
      if (r.file !== c.file) return false;
      const seg = lastLiteralSegment(r.path);
      if (seg)
        return [`/${seg}`, `'${seg}'`, `"${seg}"`, `\`${seg}`].some((s) => text.includes(s.toLowerCase()));
      return (
        /\bindex\(|path=["'{]\/["'}]|path:\s*["']\/?["']/.test(text) ||
        text.includes(`'${r.path}'`) ||
        text.includes(`"${r.path}"`)
      );
    })
  )
    return true;
  const opens = (c.text.match(/\(/g)?.length ?? 0) > (c.text.match(/\)/g)?.length ?? 0);
  return eps.some((e) => {
    if (!("method" in e) || e.file !== c.file) return false;
    if (!e.registration) return true;
    const at = refLine(e.registration);
    return (
      refFile(e.registration) === c.file && (at === c.line || (opens && at > c.line && at <= c.line + 2))
    );
  });
}

/** Sites the README lists as not labelled: lines of the form "- `<case>` `<file>:<line>`: <reason>". */
export function listedSites(readme: string, name: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of readme.split("\n")) {
    const m = /^- `([^`]+)` `([^`]+:\d+)`: (\S.*)$/.exec(l);
    if (m && m[1] === name) out.set(m[2] as string, m[3] as string);
  }
  return out;
}

/** Candidates no label covers and the README does not list. */
export function unlabelled(dir: string, repo: Repo, labels: Labels, readme: string): Candidate[] {
  const listed = listedSites(readme, repo.name);
  return [
    ...(scansRoutes(labels)
      ? candidates(dir, repo.stack).filter(
          (c) =>
            !covers(labels, c) &&
            !listed.has(`${c.file}:${c.line}`) &&
            !(c.kind === "file" && listed.has(`${c.file}:1`)),
        )
      : []),
    ...(scansData(labels)
      ? dataHits(dir, repo.stack, labels)
          .filter((h) => !h.covered && !listed.has(`${h.file}:${h.line}`))
          .map((h) => ({ file: h.file, line: h.line, kind: "data" as const, text: h.text }))
      : []),
  ];
}

/** The registration scan runs for a case that labels routes or endpoints, and for one that labels no data access. */
const scansRoutes = (labels: Labels) =>
  labels.kinds.includes("route") || labels.kinds.includes("endpoint") || !scansData(labels);
/** The data-access scan runs for a case that labels tables. */
const scansData = (labels: Labels) => labels.kinds.includes("table");

/** Every site the README lists for a case that is not a candidate of the scan (a stale entry). */
export function staleListed(dir: string, repo: Repo, readme: string, labels?: Labels): string[] {
  const seen = new Set([
    ...(!labels || scansRoutes(labels) ? candidates(dir, repo.stack) : []).map((c) => `${c.file}:${c.line}`),
    ...(!labels || scansData(labels) ? dataHits(dir, repo.stack, null) : []).map(
      (h) => `${h.file}:${h.line}`,
    ),
  ]);
  return [...listedSites(readme, repo.name).keys()].filter(
    (k) => !seen.has(k) && !seen.has(`${refFile(k)}:1`),
  );
}

// ---- Data-access patterns (#269) ----

type AccessKind = "read" | "write" | "any";

/** One access pattern: a regex over a line, the kind of access, and which group (if any) names the table. */
interface Access {
  re: RegExp;
  kind: AccessKind;
  token?: number;
}

interface DataStack {
  /** The entry of a repo's `stack` this scan belongs to. */
  stack: string;
  access: Access[];
  /** Table definitions found in a file's lines: `[line, name]` pairs. */
  tables: (file: string, lines: string[]) => [number, string][];
  /** Extensions (without dot) the table and the access scans read. */
  tableExt: string[];
  accessExt: string[];
}

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** The class declared on the first lines after `from` (decorators sit between). */
function classAfter(lines: string[], from: number): string | undefined {
  for (let i = from; i < Math.min(lines.length, from + 8); i++) {
    const m = /\bclass\s+(\w+)/.exec(lines[i] as string);
    if (m) return m[1];
  }
  return undefined;
}

/** `@Entity(...)` / `@Table(...)` decorators: an explicit name or table option, else the class name. */
function decorated(decorator: string, nameOption: RegExp, naming: (c: string) => string) {
  const re = new RegExp(`@${decorator}\\b`);
  return (_file: string, lines: string[]): [number, string][] => {
    const out: [number, string][] = [];
    lines.forEach((line, i) => {
      if (!re.test(line)) return;
      const explicit = nameOption.exec(line)?.[1];
      const cls = classAfter(lines, i);
      const name = explicit ?? (cls ? naming(cls) : undefined);
      if (name) out.push([i + 1, name]);
    });
    return out;
  };
}

const ORM_READ = "find\\w*|count\\w*|createQueryBuilder|getMany|getOne|aggregate";
const ORM_WRITE =
  "save|insert|update|delete|remove|softDelete|upsert|persist\\w*|nativeInsert|nativeUpdate|nativeDelete";
const quoted = (table: string) => new RegExp(`${table}\\(\\s*['"\`](\\w+)['"\`]`);

const dataStacks: DataStack[] = [
  {
    stack: "prisma",
    tableExt: ["prisma"],
    accessExt: ["ts", "tsx", "js", "mjs", "cjs"],
    tables: (_f, lines) => {
      const out: [number, string][] = [];
      for (let i = 0; i < lines.length; i++) {
        const m = /^model\s+(\w+)/.exec(lines[i] as string);
        if (!m) continue;
        let name = m[1] as string;
        for (let j = i + 1; j < lines.length && !/^}/.test(lines[j] as string); j++) {
          const map = /@@map\(\s*(?:name:\s*)?"([^"]+)"/.exec(lines[j] as string);
          if (map) name = map[1] as string;
        }
        out.push([i + 1, name]);
      }
      return out;
    },
    access: [
      {
        re: /\b(?:prisma|db|client|tx)\.([a-z]\w*)\.(?:findUnique\w*|findFirst\w*|findMany|count|aggregate|groupBy)\(/,
        kind: "read",
        token: 1,
      },
      {
        re: /\b(?:prisma|db|client|tx)\.([a-z]\w*)\.(?:create\w*|update\w*|upsert|delete\w*)\(/,
        kind: "write",
        token: 1,
      },
      { re: /\$(?:queryRaw|executeRaw)\w*|\bPrismaAdapter\(/, kind: "any" },
    ],
  },
  {
    stack: "drizzle",
    tableExt: ["ts"],
    accessExt: ["ts", "tsx", "js", "mjs"],
    tables: (_f, lines) =>
      lines.flatMap((l, i): [number, string][] => {
        const m = /(?:pgTable|sqliteTable|mysqlTable)\(\s*['"`](\w+)['"`]/.exec(l);
        return m ? [[i + 1, m[1] as string]] : [];
      }),
    access: [
      {
        re: /\.(?:from|innerJoin|leftJoin|rightJoin|fullJoin)\(\s*(?:\w+\.)?(\w+)\s*[,)]/,
        kind: "read",
        token: 1,
      },
      { re: /\.query\.(\w+)\.find\w*\(/, kind: "read", token: 1 },
      { re: /\.(?:insert|update|delete)\(\s*(?:\w+\.)?(\w+)\s*\)/, kind: "write", token: 1 },
      { re: /\bdrizzleAdapter\(/, kind: "any" },
    ],
  },
  {
    stack: "typeorm",
    tableExt: ["ts"],
    accessExt: ["ts", "js"],
    tables: decorated("Entity", /@Entity\(\s*['"`](\w+)['"`]/, snake),
    access: [
      { re: new RegExp(`\\b(\\w+?)(?:Repository|Repo)\\.(?:${ORM_READ})\\(`), kind: "read", token: 1 },
      { re: new RegExp(`\\b(\\w+?)(?:Repository|Repo)\\.(?:${ORM_WRITE})\\(`), kind: "write", token: 1 },
      { re: /\bgetRepository\(\s*(\w+)\s*\)/, kind: "any", token: 1 },
      {
        re: /\b(?:manager|entityManager|em)\.(?:find\w*|save|insert|update|delete|remove|query)\(\s*(\w+)/,
        kind: "any",
        token: 1,
      },
    ],
  },
  {
    stack: "mikro-orm",
    tableExt: ["ts"],
    accessExt: ["ts", "js"],
    tables: decorated("Entity", /tableName:\s*['"`](\w+)['"`]/, snake),
    access: [
      { re: new RegExp(`\\b(\\w+?)(?:Repository|Repo)\\.(?:${ORM_READ})\\(`), kind: "read", token: 1 },
      { re: new RegExp(`\\b(\\w+?)(?:Repository|Repo)\\.(?:${ORM_WRITE})\\(`), kind: "write", token: 1 },
      { re: /\bem\.(?:find\w*|count)\(\s*(\w+)/, kind: "read", token: 1 },
      { re: /\bem\.(?:flush|persist\w*|remove|nativeDelete|nativeUpdate|nativeInsert)\(/, kind: "write" },
      { re: /\.(?:selectFrom|innerJoin|leftJoin)\(\s*['"`](\w+)/, kind: "read", token: 1 },
      { re: /\.(?:insertInto|updateTable|deleteFrom)\(\s*['"`](\w+)/, kind: "write", token: 1 },
    ],
  },
  {
    stack: "kysely",
    tableExt: ["ts"],
    accessExt: ["ts", "js"],
    tables: (_f, lines) => {
      const out: [number, string][] = [];
      let open = false;
      lines.forEach((l, i) => {
        if (/\binterface\s+(?:Database|DB)\b/.test(l)) open = true;
        else if (open && /^\s*}/.test(l)) open = false;
        else if (open) {
          const m = /^\s*['"]?(\w+)['"]?\s*:/.exec(l);
          if (m) out.push([i + 1, m[1] as string]);
        }
      });
      return out;
    },
    access: [
      { re: /\.(?:selectFrom|innerJoin|leftJoin)\(\s*['"`](\w+)/, kind: "read", token: 1 },
      { re: /\.(?:insertInto|updateTable|deleteFrom)\(\s*['"`](\w+)/, kind: "write", token: 1 },
    ],
  },
  {
    stack: "sequelize",
    tableExt: ["ts"],
    accessExt: ["ts", "js"],
    tables: (f, lines) => [
      ...decorated("Table", /tableName:\s*['"`](\w+)['"`]/, (c) => c)(f, lines),
      ...lines.flatMap((l, i): [number, string][] => {
        const m = quoted("\\.define").exec(l);
        return m ? [[i + 1, m[1] as string]] : [];
      }),
    ],
    access: [
      {
        re: /\b([A-Z]\w*)(?:\.scope\([^)]*\))?\.(?:findAll|findByPk|findOne|findAndCountAll|count|max|min|sum)\(/,
        kind: "read",
        token: 1,
      },
      {
        re: /\b([A-Z]\w*)(?:\.scope\([^)]*\))?\.(?:create|findOrCreate|bulkCreate|update|destroy|upsert|increment|decrement|restore|truncate)\(/,
        kind: "write",
        token: 1,
      },
      { re: /\bsequelize\.query\(/, kind: "any" },
    ],
  },
  {
    stack: "mongoose",
    tableExt: ["ts"],
    accessExt: ["ts", "js"],
    tables: (_f, lines) =>
      lines.flatMap((l, i): [number, string][] => {
        const m = /\bmodel(?:<[^(]*>)?\(\s*['"`](\w+)['"`]/.exec(l);
        return m ? [[i + 1, m[1] as string]] : [];
      }),
    access: [
      {
        re: /\b([A-Z]\w*)\.(?:find\w*|countDocuments|estimatedDocumentCount|aggregate|exists|distinct|paginate)\(/,
        kind: "read",
        token: 1,
      },
      {
        re: /\b([A-Z]\w*)\.(?:create|insertMany|update\w*|delete\w*|replaceOne|bulkWrite|findOneAndUpdate|findByIdAndUpdate|findByIdAndDelete|findOneAndDelete)\(/,
        kind: "write",
        token: 1,
      },
      { re: /\bthis\.(?:find\w*|countDocuments)\(/, kind: "read" },
    ],
  },
  {
    stack: "pg",
    tableExt: ["sql", "ts"],
    accessExt: ["ts", "js"],
    tables: (_f, lines) =>
      lines.flatMap((l, i): [number, string][] => {
        const m = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:\$\{\w+\}\.|:?\w+\.)?"?(\w+)/i.exec(l);
        return m ? [[i + 1, m[1] as string]] : [];
      }),
    access: [
      { re: /(?<!delete\s+)\b(?:from|join)\s+(?:\$\{\w+\}\.|\w+\.)?"?(\w+)/i, kind: "read", token: 1 },
      {
        re: /\b(?:insert\s+into|update|delete\s+from)\s+(?:\$\{\w+\}\.|\w+\.)?"?(\w+)/i,
        kind: "write",
        token: 1,
      },
      { re: /\$\{\w+\}\.\w+\(/, kind: "any" },
    ],
  },
];

/** Paths the data-access scan leaves out: tests, e2e, docs, examples, mocks, scripts, seeds, generated and vendored
 * code. */
const DATA_LEFT_OUT =
  /(^|\/)(node_modules|dist|build|\.next|\.git|coverage|vendor|docs?|website|examples?|scripts|e2e|mocks?|__mocks__|fixtures?|\.storybook|stories|generated|seeders?|seeds?)(\/|$)|test|spec|stories|\.d\.ts$|\.gen\.|generated|(^|\/)seed\.\w+$/i;

function dataFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    if (DATA_LEFT_OUT.test(r)) continue;
    if (statSync(join(dir, r)).isDirectory()) out.push(...dataFiles(dir, r));
    else out.push(r);
  }
  return out;
}

export interface DataHit {
  file: string;
  line: number;
  kind: "table" | AccessKind;
  /** The labelled table the call names, when it names one. */
  table?: string;
  /** What is missing when no label covers the hit. */
  text: string;
  covered: boolean;
}

/**
 * Table definitions and data-access calls of the clone found by the patterns of the stacks in `stack`. With
 * `labels`, each hit says whether a label covers it: a definition by a `table` label, a call that names a labelled
 * table by a `read` / `write` label of that table for the file, a call that names none by a label of its kind for
 * the file. A call whose name is not a labelled table (an alias, a local variable) is not a hit. Without `labels`
 * every hit is returned, uncovered.
 */
export function dataHits(dir: string, stack: string[], labels: Labels | null): DataHit[] {
  const out: DataHit[] = [];
  const active = dataStacks.filter((s) => stack.includes(s.stack));
  if (!active.length) return out;
  const files = dataFiles(dir);
  const labelled = (kind: "read" | "write", f: string, table?: string) =>
    labels?.[kind].some((p) => p.file === f && (table === undefined || sameTable(p.table, table))) ?? false;
  for (const s of active)
    for (const f of files) {
      const ext = f.slice(f.lastIndexOf(".") + 1);
      const wantTables = s.tableExt.includes(ext);
      const wantAccess = s.accessExt.includes(ext);
      if (!wantTables && !wantAccess) continue;
      const lines = readFileSync(join(dir, f), "utf8").split("\n");
      if (wantTables)
        for (const [line, name] of s.tables(f, lines)) {
          const has = labels?.table.find((t) => sameTable(t.name, name));
          out.push({
            file: f,
            line,
            kind: "table",
            table: has?.name,
            text: `table ${name} has no table label`,
            covered: !!has,
          });
        }
      if (!wantAccess) continue;
      lines.forEach((text, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
        for (const a of s.access) {
          const m = a.re.exec(text);
          if (!m) continue;
          const token = a.token ? m[a.token] : undefined;
          let table: string | undefined;
          if (token !== undefined && labels) {
            table = labels.table.find((t) => sameTable(t.name, token))?.name;
            if (!table) continue;
          }
          const kinds = a.kind === "any" ? (["read", "write"] as const) : [a.kind];
          out.push({
            file: f,
            line: i + 1,
            kind: a.kind,
            table,
            text: `${a.kind === "any" ? "access" : a.kind}${table ? ` ${table}` : ""}: ${text.trim().slice(0, 100)}`,
            covered: kinds.some((k) => labelled(k, f, table)),
          });
        }
      });
    }
  return out;
}

export interface SampleLine {
  id: string;
  file: string;
  line: number;
  text: string;
}

/** Id of a label: its kind and its scoring key. */
function ids(labels: Labels): {
  id: string;
  file: string;
  hint?: string;
  registration?: string;
  /** A table, read or write label: its source line is a data-access hit. */
  data?: { kind: "table" | "read" | "write"; table: string };
}[] {
  const out: ReturnType<typeof ids> = [];
  for (const r of labels.route)
    out.push({ id: `route ${r.path}`, file: r.file, hint: lastLiteralSegment(r.path) });
  for (const e of labels.endpoint as EndpointLabel[])
    out.push({
      id: `endpoint ${"method" in e ? `${e.method.toUpperCase()} ${e.path}` : endpointKey(e)}`,
      file: e.file,
      hint: "path" in e ? lastLiteralSegment(e.path) : "rpc" in e ? e.rpc.split(".").at(-1) : e.fn,
      registration: "registration" in e ? e.registration : undefined,
    });
  for (const t of labels.table)
    out.push({ id: `table ${t.name}`, file: "", data: { kind: "table", table: t.name } });
  for (const k of ["read", "write"] as const)
    for (const p of labels[k])
      out.push({ id: `${k} ${p.file}|${p.table}`, file: p.file, data: { kind: k, table: p.table } });
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Every `every`-th label (the first, the eleventh, ...) in id order, with the line of its source: the registration
 * when it has one, otherwise the first line of its file that holds the label's name, or the first line. */
export function sample(labels: Labels, dir: string, every = 10, stack: string[] = []): SampleLine[] {
  const out: SampleLine[] = [];
  const hits =
    labels.table.length + labels.read.length + labels.write.length ? dataHits(dir, stack, labels) : [];
  ids(labels).forEach((l, i) => {
    if (i % every) return;
    if (l.data) {
      // A table is shown at its definition, a read or write at the first call of that file that names the table.
      const { kind, table } = l.data;
      const hit = hits.find(
        (h) =>
          sameTable(h.table ?? "", table) &&
          (kind === "table"
            ? h.kind === "table"
            : h.file === l.file && (h.kind === kind || h.kind === "any")),
      );
      const file = hit?.file ?? l.file;
      const lines = existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8").split("\n") : [];
      const line = hit?.line ?? 1;
      out.push({ id: l.id, file, line, text: (lines[line - 1] ?? "").trim().slice(0, 160) });
      return;
    }
    const p = join(dir, l.file);
    const lines = existsSync(p) ? readFileSync(p, "utf8").split("\n") : [];
    let line = l.registration ? refLine(l.registration) : 0;
    if (!line) {
      const hint = l.hint?.toLowerCase();
      const body = (t: string) => !/^\s*(?:import\b|\/\/|\*)/.test(t);
      const site =
        /createFileRoute\(|<Route\b|\b(?:path|index|route)\b\s*[:=(]|export default|^\s*\w+:\s*\w*[Pp]rocedure|createServerFn\(/;
      const find = (ok: (t: string) => boolean) => lines.findIndex((t) => body(t) && ok(t)) + 1;
      const has = (t: string) => (hint ? t.toLowerCase().includes(hint) : false);
      line = find((t) => site.test(t) && has(t)) || find(has) || find((t) => site.test(t)) || 1;
    }
    out.push({ id: l.id, file: l.file, line, text: (lines[line - 1] ?? "").trim().slice(0, 160) });
  });
  return out;
}

// Candidate scan of the table, read and write labels of the data-access cases (spec section 13). It looks for
// table definitions and data-access call sites with the fixed patterns of each stack and reports the ones no
// label covers. It reads the clone, never a Gantry dump, and it does not decide what a label should say: it only
// shows what a human labeller has not yet looked at.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Labels } from "./eval-lib.js";

type Kind = "read" | "write" | "any";

/** One access pattern: a regex over a line, the kind of access, and which group (if any) names the table. */
interface Access {
  re: RegExp;
  kind: Kind;
  token?: number;
}

interface Stack {
  /** Stack names of `repos.json` this scan belongs to. */
  stack: string;
  /** Extensions the access patterns are run on. */
  access: Access[];
  /** Table definitions found in a file's lines: `[line, name]` pairs. */
  tables: (file: string, lines: string[]) => [number, string][];
  /** Extensions (without dot) the table scan reads. */
  tableExt: string[];
  accessExt: string[];
}

/** Lowercase, drop everything but letters and digits, drop a role suffix (`Repository`, `Entity`, ...). */
export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/(repository|repo|entity|model)$/, "");
}

/** The name and its possible singular forms (`movies` is `movie`, `categories` is `category`). */
function forms(s: string): string[] {
  const n = normName(s);
  const out = new Set([n]);
  if (/ies$/.test(n)) out.add(`${n.slice(0, -3)}y`);
  if (/es$/.test(n)) out.add(n.slice(0, -2));
  if (/s$/.test(n) && !/ss$/.test(n)) out.add(n.slice(0, -1));
  out.delete("");
  return [...out];
}

/** Whether a table name and a name found in code (a model, a variable, a table in SQL) are the same table. */
export function sameTable(a: string, b: string): boolean {
  const xs = forms(a);
  const ys = forms(b);
  return xs.some((x) =>
    ys.some((y) => x === y || (Math.min(x.length, y.length) >= 3 && (x.endsWith(y) || y.endsWith(x)))),
  );
}

/** Whether `text` mentions the table by its name, a plural or singular form, or with underscores dropped. */
export function holdsTable(text: string | undefined, table: string): boolean {
  if (text === undefined) return false;
  const lower = text.toLowerCase();
  if (lower.includes(table.toLowerCase())) return true;
  const flat = lower.replace(/[^a-z0-9]/g, "");
  return forms(table).some((f) => flat.includes(f));
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

const stacks: Stack[] = [
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
      { re: /\$(?:queryRaw|executeRaw)\w*/, kind: "any" },
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
        const m = /\.define\(\s*['"`](\w+)['"`]/.exec(l);
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

/** Directories and files the labels leave out (tests, e2e, storybook, docs, examples, mocks, scripts, seeds,
 * generated and vendored code). */
const LEFT_OUT =
  /(^|\/)(node_modules|dist|build|\.next|\.git|coverage|vendor|docs?|website|examples?|scripts|e2e|mocks?|__mocks__|fixtures?|\.storybook|stories|generated|seeders?|seeds?)(\/|$)|test|spec|stories|\.d\.ts$|\.gen\.|generated|(^|\/)seed\.\w+$/i;

function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    if (LEFT_OUT.test(r)) continue;
    if (statSync(join(dir, r)).isDirectory()) out.push(...walk(dir, r));
    else out.push(r);
  }
  return out;
}

/** Every `n`-th label of the file (the n-th, 2n-th, ...) with its kind and key, sorted by kind then key. */
export function sampleLabels(labels: Labels, n: number): string[] {
  const all = [
    ...labels.route.map((r) => `route ${r.path}`),
    ...labels.endpoint.map(
      (e) =>
        `endpoint ${"method" in e ? `${e.method} ${e.path}` : "rpc" in e ? `rpc ${e.rpc}` : `fn ${e.fn}`}`,
    ),
    ...labels.table.map((t) => `table ${t.name}`),
    ...labels.read.map((r) => `read ${r.file}|${r.table}`),
    ...labels.write.map((w) => `write ${w.file}|${w.table}`),
    ...labels.link.map((l) => `link ${l.file}|${l.endpoint}`),
  ].sort();
  return all.filter((_, i) => (i + 1) % n === 0);
}

/** The known stacks that appear in a repo's `stack` list. */
export const scannedStacks = (stack: string[]) => stacks.filter((s) => stack.includes(s.stack));

/**
 * Table definitions and access sites in the clone that no label covers: a definition whose name is not a
 * `table` label, an access whose table (when the call names one) has no `read` / `write` label for the file,
 * or (when the call names none) whose file has no label of that kind and no `unresolved` entry.
 */
export function unlabelledCandidates(labels: Labels, cloneDir: string, stack: string[]): string[] {
  if (!existsSync(cloneDir)) return [];
  const out: string[] = [];
  const files = walk(cloneDir);
  const unresolvedIn = (f: string) => labels.unresolved.some((u) => u.file === f);
  const labelled = (kind: "read" | "write", f: string, table?: string) =>
    labels[kind].some((p) => p.file === f && (table === undefined || sameTable(p.table, table)));
  for (const s of scannedStacks(stack)) {
    for (const f of files) {
      const ext = f.slice(f.lastIndexOf(".") + 1);
      const wantTables = s.tableExt.includes(ext);
      const wantAccess = s.accessExt.includes(ext);
      if (!wantTables && !wantAccess) continue;
      const lines = readFileSync(join(cloneDir, f), "utf8").split("\n");
      if (wantTables)
        for (const [line, name] of s.tables(f, lines))
          if (!labels.table.some((t) => sameTable(t.name, name)))
            out.push(`table ${name} defined at ${f}:${line} has no table label`);
      if (!wantAccess) continue;
      lines.forEach((text, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
        for (const a of s.access) {
          const m = a.re.exec(text);
          if (!m) continue;
          const kinds = a.kind === "any" ? (["read", "write"] as const) : [a.kind];
          const token = a.token ? m[a.token] : undefined;
          let table: string | undefined;
          if (token !== undefined) {
            table = labels.table.find((t) => sameTable(t.name, token))?.name;
            if (!table) continue; // the name is not one of the labelled tables (an alias, a local variable)
          }
          const covered =
            kinds.some((k) => labelled(k, f, table)) || (token === undefined && unresolvedIn(f));
          if (!covered)
            out.push(
              `${a.kind === "any" ? "access" : a.kind} ${f}:${i + 1} ${table ?? ""}: ${text.trim().slice(0, 100)}`,
            );
        }
      });
    }
  }
  return out;
}

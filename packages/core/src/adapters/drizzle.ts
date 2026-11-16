import { isNode, type Node, nodeArray, unwrap, visit } from "../parse/ast.js";
import type { EdgeRecord, WorkspaceRecord } from "../types.js";
import {
  type Adapter,
  type AdapterNode,
  cmp,
  enclosingSymbol,
  hasDependency,
  IdAllocator,
  lineOf,
  stringValue,
  symbolForName,
} from "./framework.js";

/**
 * Drizzle tables and the functions that read or write them (https://orm.drizzle.team/docs/sql-schema-declaration,
 * /docs/select, /docs/insert, /docs/update, /docs/delete, /docs/rqb, /docs/query-utils; checked 2026-11).
 *
 * Tables (top-level `const` in a workspace depending on `drizzle-orm`):
 *
 * | Pattern                                               | Module                        | Dialect |
 * | ----------------------------------------------------- | ----------------------------- | ------- |
 * | `sqliteTable("name", { col: text(), ... }, extra?)`   | `drizzle-orm/sqlite-core`     | sqlite  |
 * | `pgTable("name", { ... })`                            | `drizzle-orm/pg-core`         | pg      |
 * | `mysqlTable("name", { ... })`                         | `drizzle-orm/mysql-core`      | mysql   |
 * | `xTable("name", (t) => ({ ... }))` (callback columns) | any of the above              |         |
 *
 * Usage (any call in any function; `T` is a table binding, a namespace member `schema.T` included):
 *
 * | Call                                                     | Edge     |
 * | -------------------------------------------------------- | -------- |
 * | `<chain>.from(T)` (after `select()` / `selectDistinct()`) | `reads`  |
 * | `<chain>.leftJoin|rightJoin|innerJoin|fullJoin(T, ...)`  | `reads`  |
 * | `alias(T, "a")` used in any of these                     | as `T`   |
 * | `db.$count(T, ...)`                                      | `reads`  |
 * | `db.query.<t>.findMany|findFirst(...)` (also `_query`)   | `reads`  |
 * | `db.insert(T)`, `db.update(T)`, `db.delete(T)`           | `writes` |
 *
 * `<t>` in the relational query API is a key of the schema passed to `drizzle()`, which is the table's export name.
 * `from` and the joins count only on a call chain (`db.select().from(T)`), so `Array.from(x)` never does. Raw SQL
 * (`sql\`...\``, `db.run(...)`) is not read.
 *
 * Node `table:<name>` (kind `table`) with data `{ adapter, name, exportName, symbol, dialect, columns, file, line }`.
 * Edge `reads` / `writes` from the code holding the call (its symbol, or the file for module-level code) to the
 * table, evidence `path:line` per call, confidence `high` when the binding resolves to the table's export (or the
 * query key names exactly one table) and `low` when the import does not resolve and only the name matches.
 * Usage counts only in workspaces that depend on `drizzle-orm` or on a workspace that does.
 */

const TABLE_FNS: Record<string, { module: string; dialect: string }> = {
  sqliteTable: { module: "drizzle-orm/sqlite-core", dialect: "sqlite" },
  pgTable: { module: "drizzle-orm/pg-core", dialect: "pg" },
  mysqlTable: { module: "drizzle-orm/mysql-core", dialect: "mysql" },
};
const DRIZZLE = "drizzle-orm";
const ALIAS_MODULES = new Set(Object.values(TABLE_FNS).map((t) => t.module));
const READ_CHAIN = new Set(["from", "leftJoin", "rightJoin", "innerJoin", "fullJoin"]);
const WRITES = new Set(["insert", "update", "delete"]);
const QUERY_METHODS = new Set(["findMany", "findFirst"]);
const QUERY_ROOTS = new Set(["query", "_query"]);
const MAY_MATCH =
  /\.(?:from|leftJoin|rightJoin|innerJoin|fullJoin|insert|update|delete|\$count|findMany|findFirst)\(|Table\(/;

interface TableFact {
  name: string;
  exportName: string;
  symbol: string | null;
  dialect: string;
  columns: string[];
  line: number;
}
/** A table reference: a binding (resolved to a symbol, or an unresolved import by name) or a relational query key. */
type TableRef = { t: "sym"; sym: string } | { t: "name"; name: string } | { t: "query"; key: string };
interface UsageFact {
  kind: "reads" | "writes";
  src: string;
  ref: TableRef;
  line: number;
}
export interface DrizzleFacts {
  tables: TableFact[];
  usages: UsageFact[];
}

function columnsOf(arg: unknown): string[] {
  let v = unwrap(arg);
  if (isNode(v) && (v.type === "ArrowFunctionExpression" || v.type === "FunctionExpression")) {
    let body = unwrap(v.body);
    if (isNode(body) && body.type === "BlockStatement") {
      const ret = nodeArray(body.body).find((s) => s.type === "ReturnStatement");
      body = unwrap(ret?.argument);
    }
    v = body;
  }
  if (!isNode(v) || v.type !== "ObjectExpression") return [];
  const out: string[] = [];
  for (const p of nodeArray(v.properties)) {
    if (p.type !== "Property") continue;
    const k = unwrap(p.key);
    const name =
      isNode(k) && k.type === "Identifier" && p.computed !== true ? (k.name as string) : stringValue(k);
    if (name !== null) out.push(name);
  }
  return out;
}

export const drizzleAdapter: Adapter<DrizzleFacts> = {
  id: "drizzle",
  // Usage can sit in a workspace that only depends on the package defining the schema; `link` keeps usage only
  // in workspaces that depend on drizzle-orm or on such a workspace, and tables only where drizzle-orm is a dependency.
  appliesTo: () => true,
  mayMatch: (file) => MAY_MATCH.test(file.source),
  extract(ctx) {
    const program = ctx.program();
    if (!program) return {};
    const pf = ctx.parsed;
    const facts: DrizzleFacts = { tables: [], usages: [] };

    if (hasDependency(ctx.ws, [DRIZZLE])) {
      const tableLocals = new Map<string, string>();
      for (const i of pf?.imports ?? []) {
        const t = TABLE_FNS[i.imported];
        if (t && i.local && i.specifier === t.module) tableLocals.set(i.local, t.dialect);
      }
      if (tableLocals.size > 0) {
        for (const st of program) {
          const decl = st.type === "ExportNamedDeclaration" ? unwrap(st.declaration) : st;
          if (!isNode(decl) || decl.type !== "VariableDeclaration") continue;
          for (const d of nodeArray(decl.declarations)) {
            const id = unwrap(d.id);
            const init = unwrap(d.init);
            if (!isNode(id) || id.type !== "Identifier" || !isNode(init) || init.type !== "CallExpression")
              continue;
            const callee = unwrap(init.callee);
            if (!isNode(callee) || callee.type !== "Identifier") continue;
            const dialect = tableLocals.get(callee.name as string);
            const args = nodeArray(init.arguments);
            const name = stringValue(args[0]);
            if (!dialect || name === null) continue;
            const local = id.name as string;
            const exp = pf?.exports.find(
              (e) => e.local === local && e.fromSpecifier === undefined && !e.star,
            );
            facts.tables.push({
              name,
              exportName: st.type === "ExportNamedDeclaration" ? local : (exp?.exported ?? local),
              symbol: pf?.symbols.find((s) => s.name === local)?.id ?? null,
              dialect,
              columns: columnsOf(args[1]),
              line: lineOf(ctx.source, d.start),
            });
          }
        }
      }
    }

    // `const reviewer = alias(users, "reviewer")`, in any scope: the alias reads the aliased table.
    const aliasLocals = new Set(
      (pf?.imports ?? [])
        .filter((i) => i.imported === "alias" && i.local && ALIAS_MODULES.has(i.specifier))
        .map((i) => i.local),
    );
    const aliases = new Map<string, unknown>();
    if (aliasLocals.size > 0) {
      visit(program, (n) => {
        if (n.type !== "VariableDeclarator") return undefined;
        const id = unwrap(n.id);
        const init = unwrap(n.init);
        if (!isNode(id) || id.type !== "Identifier" || !isNode(init) || init.type !== "CallExpression")
          return undefined;
        const c = unwrap(init.callee);
        if (isNode(c) && c.type === "Identifier" && aliasLocals.has(c.name as string)) {
          aliases.set(id.name as string, nodeArray(init.arguments)[0]);
        }
        return undefined;
      });
    }

    const refOf = (arg: unknown, depth = 0): TableRef | null => {
      const v = unwrap(arg);
      if (!isNode(v)) return null;
      if (v.type === "Identifier") {
        const name = v.name as string;
        const aliased = aliases.get(name);
        if (aliased !== undefined && depth < 4) return refOf(aliased, depth + 1);
        const sym = symbolForName(pf, ctx.fileId, name, ctx.resolver);
        if (sym) return { t: "sym", sym };
        // An import that does not resolve: matched by name, low confidence.
        return pf?.imports.some((i) => i.local === name && i.imported !== "*")
          ? { t: "name", name: pf.imports.find((i) => i.local === name)?.imported ?? name }
          : null;
      }
      // `schema.posts` on a namespace import.
      if (v.type === "MemberExpression" && v.computed !== true) {
        const o = unwrap(v.object);
        const p = v.property;
        if (!isNode(o) || o.type !== "Identifier" || !isNode(p) || p.type !== "Identifier") return null;
        const ns = pf?.imports.find((i) => i.local === o.name && i.imported === "*");
        if (!ns) return null;
        const target = ctx.resolver.resolveSpecifier(ctx.fileId, ns.specifier);
        const sym =
          target.kind === "file" ? ctx.resolver.resolveSymbol(target.fileId, p.name as string) : null;
        return sym ? { t: "sym", sym } : { t: "name", name: p.name as string };
      }
      return null;
    };

    visit(program, (n) => {
      if (n.type !== "CallExpression") return undefined;
      const callee = unwrap(n.callee);
      if (!isNode(callee) || callee.type !== "MemberExpression" || callee.computed === true) return undefined;
      const prop = callee.property;
      if (!isNode(prop) || prop.type !== "Identifier") return undefined;
      const method = prop.name as string;
      const obj = unwrap(callee.object);
      let kind: UsageFact["kind"] | null = null;
      let ref: TableRef | null = null;
      if (READ_CHAIN.has(method)) {
        if (isNode(obj) && obj.type === "CallExpression") {
          kind = "reads";
          ref = refOf(nodeArray(n.arguments)[0]);
        }
      } else if (method === "$count") {
        kind = "reads";
        ref = refOf(nodeArray(n.arguments)[0]);
      } else if (WRITES.has(method)) {
        kind = "writes";
        ref = refOf(nodeArray(n.arguments)[0]);
      } else if (QUERY_METHODS.has(method) && isNode(obj) && obj.type === "MemberExpression") {
        const q = unwrap(obj.object);
        const key = obj.property;
        if (
          obj.computed !== true &&
          isNode(key) &&
          key.type === "Identifier" &&
          isNode(q) &&
          q.type === "MemberExpression" &&
          q.computed !== true &&
          isNode(q.property) &&
          QUERY_ROOTS.has(q.property.name as string)
        ) {
          kind = "reads";
          ref = { t: "query", key: key.name as string };
        }
      }
      if (kind && ref) {
        facts.usages.push({
          kind,
          src: enclosingSymbol(pf, ctx.fileId, n.start),
          ref,
          line: lineOf(ctx.source, (callee.property as Node).start),
        });
      }
      return undefined;
    });
    return facts.tables.length > 0 || facts.usages.length > 0 ? { facts } : {};
  },
  link(ctx) {
    const nodes: AdapterNode[] = [];
    const bySym = new Map<string, string>();
    const byExport = new Map<string, string[]>();
    const alloc = new IdAllocator();
    for (const { file, facts } of ctx.files) {
      for (const t of facts?.tables ?? []) {
        const id = alloc.take(`table:${t.name}`);
        nodes.push({
          id,
          kind: "table",
          ws: file.ws.id,
          label: t.name,
          fileId: file.fileId,
          data: {
            adapter: "drizzle",
            name: t.name,
            exportName: t.exportName,
            symbol: t.symbol,
            dialect: t.dialect,
            columns: t.columns,
            file: file.path,
            line: t.line,
          },
        });
        if (t.symbol) bySym.set(t.symbol, id);
        byExport.set(t.exportName, [...(byExport.get(t.exportName) ?? []), id]);
      }
    }
    if (nodes.length === 0) return {};

    // Workspaces whose code may use the tables: drizzle-orm itself, or a direct dependency on a workspace that has it.
    const drizzleWs = new Set(ctx.workspaces.filter((w) => hasDependency(w, [DRIZZLE])).map((w) => w.name));
    const usesDrizzle = (ws: WorkspaceRecord): boolean =>
      drizzleWs.has(ws.name) || ws.deps.some((d) => drizzleWs.has(d));

    const acc = new Map<string, EdgeRecord & { lines: Set<number>; path: string }>();
    for (const { file, facts } of ctx.files) {
      if (!facts || facts.usages.length === 0 || !usesDrizzle(file.ws)) continue;
      for (const u of facts.usages) {
        let targets: string[] = [];
        let confidence: "high" | "low" = "high";
        if (u.ref.t === "sym") {
          const id = bySym.get(u.ref.sym);
          if (id) targets = [id];
        } else if (u.ref.t === "name") {
          targets = byExport.get(u.ref.name) ?? [];
          confidence = "low";
        } else {
          targets = byExport.get(u.ref.key) ?? [];
          if (targets.length > 1) confidence = "low";
        }
        for (const dst of targets) {
          const k = `${file.fileId}\0${u.src}\0${dst}\0${u.kind}`;
          let e = acc.get(k);
          if (!e) {
            e = {
              src: u.src,
              dst,
              kind: u.kind,
              confidence,
              count: 0,
              evidence: [],
              fileId: file.fileId,
              lines: new Set(),
              path: file.path,
            };
            acc.set(k, e);
          }
          if (confidence === "high") e.confidence = "high";
          e.lines.add(u.line);
          e.count++;
        }
      }
    }
    const edges: EdgeRecord[] = [...acc.values()].map(({ lines, path, ...e }) => ({
      ...e,
      evidence: [...lines].sort((a, b) => a - b).map((l) => `${path}:${l}`),
    }));
    edges.sort(
      (a, b) => cmp(a.fileId, b.fileId) || cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.kind, b.kind),
    );
    nodes.sort((a, b) => cmp(a.id, b.id));
    return { nodes, edges };
  },
};

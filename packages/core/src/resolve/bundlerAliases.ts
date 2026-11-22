import fs from "node:fs";
import path from "node:path";
import { parseSync } from "oxc-parser";
import { isNode, type Node, nodeArray, unwrap } from "../parse/ast.js";

const VITE_CONFIGS = ["ts", "mts", "js", "mjs", "cjs"].map((e) => `vite.config.${e}`);
const WEBPACK_CONFIGS = ["js", "cjs", "mjs", "ts"].map((e) => `webpack.config.${e}`);

export interface BundlerAlias {
  /** The alias key as the resolver takes it: a trailing `$` means an exact match. */
  find: string;
  /** Absolute target path. */
  target: string;
}

export interface UnreadableAlias {
  /** The alias key, or `*` when the whole `alias` value (or the key) cannot be read. */
  key: string;
}

export interface BundlerAliases {
  aliases: BundlerAlias[];
  unreadable: UnreadableAlias[];
}

/**
 * Aliases from the Vite and webpack configs in one workspace directory, read from the syntax tree. A config is
 * parsed, never imported, required or run.
 */
export function readBundlerAliases(wsAbsDir: string): BundlerAliases {
  const out: BundlerAliases = { aliases: [], unreadable: [] };
  for (const [names, vite] of [
    [VITE_CONFIGS, true],
    [WEBPACK_CONFIGS, false],
  ] as const) {
    for (const name of names) {
      const file = path.join(wsAbsDir, name);
      let source: string;
      try {
        source = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      readConfig(file, source, wsAbsDir, vite, out);
    }
  }
  return out;
}

function readConfig(file: string, source: string, dir: string, vite: boolean, out: BundlerAliases): void {
  const program = parseSync(file, source, { sourceType: "module" }).program as unknown as { body?: unknown };
  const config = exportedConfig(nodeArray(program.body));
  if (!config) return;
  const resolve = property(config, "resolve");
  if (!resolve) return;
  const resolveObj = unwrap(resolve);
  if (!isNode(resolveObj) || resolveObj.type !== "ObjectExpression") return;
  const alias = property(resolveObj, "alias");
  if (!alias) return;
  const value = unwrap(alias);
  if (isNode(value) && value.type === "ObjectExpression") {
    for (const p of nodeArray(value.properties)) {
      const key = p.type === "Property" && p.computed !== true ? propertyKey(p) : null;
      if (key === null) {
        out.unreadable.push({ key: "*" });
        continue;
      }
      add(out, key, p.value, dir, vite);
    }
  } else if (isNode(value) && value.type === "ArrayExpression") {
    for (const el of nodeArray(value.elements)) {
      const item = unwrap(el);
      if (!isNode(item) || item.type !== "ObjectExpression") {
        out.unreadable.push({ key: "*" });
        continue;
      }
      const find = unwrap(property(item, "find"));
      const key =
        isNode(find) && find.type === "Literal" && typeof find.value === "string" ? find.value : null;
      if (key === null) out.unreadable.push({ key: "*" });
      else add(out, key, property(item, "replacement"), dir, vite);
    }
  } else {
    out.unreadable.push({ key: "*" });
  }
}

function add(out: BundlerAliases, key: string, valueNode: unknown, dir: string, vite: boolean): void {
  const target = evalPath(valueNode, dir, vite);
  if (target === null) out.unreadable.push({ key });
  else out.aliases.push({ find: key, target });
}

/** The config object of `export default`, `module.exports =`, or what a default-exported function returns. */
function exportedConfig(body: Node[]): Node | null {
  for (const stmt of body) {
    if (stmt.type === "ExportDefaultDeclaration") return configObject(stmt.declaration, 0);
    if (stmt.type === "ExpressionStatement") {
      const e = unwrap(stmt.expression);
      if (isNode(e) && e.type === "AssignmentExpression" && isModuleExports(e.left)) {
        return configObject(e.right, 0);
      }
    }
  }
  return null;
}

function isModuleExports(n: unknown): boolean {
  return (
    isNode(n) &&
    n.type === "MemberExpression" &&
    isIdent(n.object, "module") &&
    isIdent(n.property, "exports") &&
    n.computed !== true
  );
}

function configObject(n: unknown, depth: number): Node | null {
  const node = unwrap(n);
  if (depth > 4 || !isNode(node)) return null;
  switch (node.type) {
    case "ObjectExpression":
      return node;
    case "CallExpression":
      return isIdent(node.callee, "defineConfig")
        ? configObject(nodeArray(node.arguments)[0], depth + 1)
        : null;
    case "ArrowFunctionExpression":
    case "FunctionExpression": {
      const body = unwrap(node.body);
      if (!isNode(body)) return null;
      if (body.type !== "BlockStatement") return configObject(body, depth + 1);
      for (const s of nodeArray(body.body)) {
        if (s.type === "ReturnStatement") {
          const r = configObject(s.argument, depth + 1);
          if (r) return r;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

function isIdent(n: unknown, name: string): boolean {
  return isNode(n) && n.type === "Identifier" && n.name === name;
}

function propertyKey(p: Node): string | null {
  const k = p.key;
  if (!isNode(k)) return null;
  if (k.type === "Identifier") return k.name as string;
  if (k.type === "Literal" && typeof k.value === "string") return k.value;
  return null;
}

function property(obj: Node, name: string): Node | undefined {
  for (const p of nodeArray(obj.properties)) {
    if (p.type === "Property" && p.computed !== true && propertyKey(p) === name) {
      return isNode(p.value) ? p.value : undefined;
    }
  }
  return undefined;
}

/**
 * An absolute path from a string literal, `path.resolve` / `path.join` of a base and literals, `fileURLToPath(new
 * URL("<literal>", import.meta.url))` or a template literal of those parts. Null when anything else is in it.
 */
function evalPath(n: unknown, dir: string, vite: boolean): string | null {
  const node = unwrap(n);
  if (!isNode(node)) return null;
  // A Vite replacement of "/src/lib" is relative to the workspace root; webpack takes an absolute path as it is.
  if (node.type === "Literal" && typeof node.value === "string") {
    return vite && node.value.startsWith("/") ? path.join(dir, node.value) : absolute(node.value);
  }
  const v = evalPart(node, dir);
  return v !== null && path.isAbsolute(v) ? v : null;
}

function absolute(p: string): string | null {
  return path.isAbsolute(p) ? p : null;
}

/** A string piece of a path expression: a literal, a base directory, or a call joining pieces. */
function evalPart(n: unknown, dir: string): string | null {
  const node = unwrap(n);
  if (!isNode(node)) return null;
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : null;
  if (node.type === "TemplateLiteral") {
    const quasis = nodeArray(node.quasis);
    const exprs = Array.isArray(node.expressions) ? node.expressions : [];
    let s = "";
    for (let i = 0; i < quasis.length; i++) {
      const cooked = (quasis[i]?.value as { cooked?: string | null } | undefined)?.cooked;
      if (typeof cooked !== "string") return null;
      s += cooked;
      if (i < exprs.length) {
        const part = evalPart(exprs[i], dir);
        if (part === null) return null;
        s += part;
      }
    }
    return s;
  }
  if (isIdent(node, "__dirname")) return dir;
  if (node.type === "MemberExpression" && node.computed !== true) {
    // import.meta.dirname
    const obj = node.object;
    if (isNode(obj) && obj.type === "MetaProperty" && isIdent(node.property, "dirname")) return dir;
    return null;
  }
  if (node.type !== "CallExpression") return null;
  const callee = unwrap(node.callee);
  const args = nodeArray(node.arguments);
  if (isNode(callee) && callee.type === "MemberExpression" && callee.computed !== true) {
    // process.cwd()
    if (isIdent(callee.object, "process") && isIdent(callee.property, "cwd") && args.length === 0) return dir;
    if (
      isIdent(callee.object, "path") &&
      (isIdent(callee.property, "resolve") || isIdent(callee.property, "join"))
    ) {
      const pieces: string[] = [];
      for (const a of args) {
        const p = evalPart(a, dir);
        if (p === null) return null;
        pieces.push(p);
      }
      // A first piece that is not a base would depend on where the indexer runs.
      if (pieces.length === 0 || !path.isAbsolute(pieces[0] as string)) return null;
      return isIdent(callee.property, "resolve") ? path.resolve(...pieces) : path.join(...pieces);
    }
    return null;
  }
  if (isIdent(callee, "fileURLToPath") && args.length === 1) {
    const url = unwrap(args[0]);
    if (!isNode(url) || url.type !== "NewExpression" || !isIdent(url.callee, "URL")) return null;
    const [rel, base] = nodeArray(url.arguments);
    const relNode = unwrap(rel);
    if (!isNode(relNode) || relNode.type !== "Literal" || typeof relNode.value !== "string") return null;
    const b = unwrap(base);
    const isImportMetaUrl =
      isNode(b) &&
      b.type === "MemberExpression" &&
      isNode(b.object) &&
      b.object.type === "MetaProperty" &&
      isIdent(b.property, "url");
    return isImportMetaUrl ? path.resolve(dir, relNode.value) : null;
  }
  return null;
}

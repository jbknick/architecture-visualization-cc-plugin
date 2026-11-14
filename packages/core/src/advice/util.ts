import { posix } from "node:path";
import type { ExportsEntry, WorkspaceRecord } from "../types.js";

export const SCRIPT_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"];
const SCRIPT_EXT_RE = /\.(?:[cm]?[jt]sx?)$/;

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function normPath(p: string): string {
  return posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "");
}

/** npm package name of a bare specifier (`@a/b/c` -> `@a/b`, `x/y` -> `x`); null when it is not a package name. */
export function packageName(spec: string): string | null {
  if (spec.startsWith("@")) return /^(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*)/i.exec(spec)?.[1] ?? null;
  const first = spec.split("/")[0];
  return first && /^[A-Za-z0-9_][\w.-]*$/.test(first) ? first : null;
}

/** Package-relative entry points of a workspace: its exports map, else `types`, `main`, then `index`. */
export function entryPoints(ws: WorkspaceRecord): ExportsEntry[] {
  if (ws.exportsMap) return ws.exportsMap;
  const out: ExportsEntry[] = [];
  for (const t of [ws.types, ws.main, "./src/index", "./index"]) if (t) out.push({ subpath: ".", target: t });
  return out;
}

/** Repo-relative file paths a package-relative target (`./src/index.js`, `./dist/x.js`) may stand for. */
export function targetCandidates(ws: WorkspaceRecord, target: string): string[] {
  const base = ws.dir === "." ? "" : ws.dir;
  const rel = normPath(posix.join(base, target));
  const out = [rel];
  const stripped = rel.replace(SCRIPT_EXT_RE, "");
  if (stripped !== rel) for (const e of SCRIPT_EXTS) out.push(stripped + e);
  for (const e of SCRIPT_EXTS) out.push(rel + e);
  for (const e of SCRIPT_EXTS) out.push(`${rel}/index${e}`);
  const wsRel = normPath(posix.relative(base, rel));
  const built = /^(?:dist|build|out|lib)\/(.*)$/.exec(wsRel);
  if (built) {
    const src = normPath(posix.join(base, "src", built[1] ?? "")).replace(SCRIPT_EXT_RE, "");
    for (const e of SCRIPT_EXTS) out.push(src + e);
  }
  return [...new Set(out)];
}

/** Does `sub` ("." or "./x") match an exports-map entry? Supports a single `*` wildcard. */
export function matchesExports(ws: WorkspaceRecord, sub: string): boolean {
  for (const e of ws.exportsMap ?? []) {
    if (e.subpath === sub) return true;
    const star = e.subpath.indexOf("*");
    if (star < 0) continue;
    const pre = e.subpath.slice(0, star);
    const post = e.subpath.slice(star + 1);
    if (sub.startsWith(pre) && sub.endsWith(post) && sub.length >= pre.length + post.length) return true;
  }
  return false;
}

/** Declared in the workspace's package.json, or in the root one (hoisted tooling). */
export function declares(ws: WorkspaceRecord, all: WorkspaceRecord[], pkg: string): boolean {
  if (ws.deps.includes(pkg)) return true;
  return all.find((w) => w.dir === ".")?.deps.includes(pkg) ?? false;
}

export function packageJsonPath(ws: WorkspaceRecord): string {
  return ws.dir === "." ? "package.json" : `${ws.dir}/package.json`;
}

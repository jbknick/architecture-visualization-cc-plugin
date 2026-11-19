/**
 * The only place stable ids are built or parsed (spec section 6). Every id except the workspace id carries the repo
 * name right after its prefix: `file:<repo>:<path>`, `sym:<repo>:<path>#<name>`, `route:<repo>:<ws>:<id>`,
 * `ep:<repo>:<ws>:<...>`, `mw:<repo>:<ws>:<...>`, `table:<repo>:<name>`, `call:<repo>:<ws>:<label>`. The repo name never
 * contains `:` (`repoName` replaces it) and neither does a workspace name, so each id splits on its first colons.
 */

export type IdKind = "file" | "sym" | "route" | "ep" | "mw" | "table" | "call";

const KINDS: readonly IdKind[] = ["file", "sym", "route", "ep", "mw", "table", "call"];

export interface ParsedId {
  kind: IdKind;
  repo: string;
  /** `file` and `sym` ids: the repo-relative posix path. */
  path?: string;
  /** `sym` ids: the symbol name (with any `~2` suffix); `table` ids: the table name. */
  name?: string;
  /** `route`, `ep`, `mw` and `call` ids: the workspace package name (the workspace id without `ws:`). */
  ws?: string;
  /** Everything after `<kind>:<repo>:` (after the workspace for the kinds that have one). */
  rest: string;
}

export const fileId = (repo: string, path: string): string => `file:${repo}:${path}`;
export const symId = (repo: string, path: string, name: string): string => `sym:${repo}:${path}#${name}`;
export const routeId = (repo: string, ws: string, id: string): string => `route:${repo}:${ws}:${id}`;
export const endpointId = (repo: string, ws: string, label: string): string => `ep:${repo}:${ws}:${label}`;
export const middlewareId = (repo: string, ws: string, label: string): string => `mw:${repo}:${ws}:${label}`;
export const callId = (repo: string, ws: string, label: string): string => `call:${repo}:${ws}:${label}`;
export const tableId = (repo: string, name: string): string => `table:${repo}:${name}`;

/** A symbol key without the repo (`<path>#<name>`): what adapters keep in node data and compare within one run. */
export const symKey = (path: string, name: string): string => `${path}#${name}`;

/** The `symKey` of a `sym:` id; undefined for any other id. */
export function symKeyOfId(id: string): string | undefined {
  const p = parseId(id);
  return p?.kind === "sym" ? symKey(p.path as string, p.name as string) : undefined;
}

/** The `<kind>:<repo>:` prefix of an id, for prefix checks and `LIKE` queries. */
export const idPrefix = (kind: IdKind, repo: string): string => `${kind}:${repo}:`;

/** The kind of an id (the text before the first colon), or undefined when it is not one of the id kinds. */
export function kindOfId(id: string): IdKind | undefined {
  const i = id.indexOf(":");
  const k = i < 0 ? "" : id.slice(0, i);
  return (KINDS as readonly string[]).includes(k) ? (k as IdKind) : undefined;
}

export const isFileId = (id: string): boolean => kindOfId(id) === "file";
export const isSymId = (id: string): boolean => kindOfId(id) === "sym";

/** Splits an id; undefined when it is not a well formed id of one of the kinds. */
export function parseId(id: string): ParsedId | undefined {
  const kind = kindOfId(id);
  if (!kind) return undefined;
  const afterKind = id.slice(kind.length + 1);
  const c = afterKind.indexOf(":");
  if (c <= 0) return undefined;
  const repo = afterKind.slice(0, c);
  const rest = afterKind.slice(c + 1);
  switch (kind) {
    case "file":
      return { kind, repo, path: rest, rest };
    case "sym": {
      const h = rest.lastIndexOf("#");
      if (h < 0) return undefined;
      return { kind, repo, path: rest.slice(0, h), name: rest.slice(h + 1), rest };
    }
    case "table":
      return { kind, repo, name: rest, rest };
    default: {
      const w = rest.indexOf(":");
      if (w < 0) return undefined;
      return { kind, repo, ws: rest.slice(0, w), rest: rest.slice(w + 1) };
    }
  }
}

/** The repo-relative path of a `file:` id; any other string is returned as it is (a path already). */
export function pathOfFileId(id: string): string {
  const p = parseId(id);
  return p?.kind === "file" ? (p.path as string) : id;
}

/** The repo-relative path of a `sym:` id; undefined for any other id. */
export function pathOfSymId(id: string): string | undefined {
  const p = parseId(id);
  return p?.kind === "sym" ? p.path : undefined;
}

/** The symbol name (with any `~2` suffix) of a `sym:` id; undefined for any other id. */
export function nameOfSymId(id: string): string | undefined {
  const p = parseId(id);
  return p?.kind === "sym" ? p.name : undefined;
}

/** The repo-relative path of a `file:` or `sym:` id; undefined for any other id. */
export function pathOfId(id: string): string | undefined {
  return pathOfSymId(id) ?? (isFileId(id) ? pathOfFileId(id) : undefined);
}

/**
 * The long form of a short id typed by a person: `route:<ws>:<path>`, `table:<name>`, `file:<path>` or `sym:<path>#<name>`
 * becomes the id with `repo` after the prefix. Undefined when `target` does not start with an id prefix. A target that
 * is already a full id also gets the repo inserted, so a caller tries the target as it is first and this second.
 */
export function qualifyId(repo: string, target: string): string | undefined {
  const kind = kindOfId(target);
  return kind === undefined ? undefined : `${kind}:${repo}:${target.slice(kind.length + 1)}`;
}

/** An id without its kind and repo parts, for labels: a path, `path#name`, a table name, `ws:rest`; `ws:` and `dir:` ids lose their prefix. */
export function displayOfId(id: string): string {
  const p = parseId(id);
  if (p === undefined) return id.replace(/^(ws|dir):/, "");
  if (p.kind === "file") return p.path as string;
  if (p.kind === "sym") return `${p.path}#${p.name}`;
  if (p.kind === "table") return p.name as string;
  return `${p.ws}:${p.rest}`;
}

/** The repo name of any id; undefined when it is not a well formed id. */
export function repoOfId(id: string): string | undefined {
  return parseId(id)?.repo;
}

/** The id of the file at repo-relative `path` in the same repo as `id`; undefined when `id` is not a well formed id. */
export function fileIdBeside(id: string, path: string): string | undefined {
  const repo = repoOfId(id);
  return repo === undefined ? undefined : fileId(repo, path);
}

/** The `sym:` id of symbol `name` in the file a `file:` id names. */
export function symIdOfFileId(id: string, name: string): string {
  const p = parseId(id);
  if (p?.kind !== "file") throw new Error(`Not a file id: ${id}`);
  return symId(p.repo, p.path as string, name);
}

/** The id of the file a `sym:` id lives in (a `file:` id is returned as it is); undefined for any other id. */
export function fileIdOfSymId(id: string): string | undefined {
  const p = parseId(id);
  if (p?.kind === "file") return id;
  return p?.kind === "sym" && p.path !== undefined ? fileId(p.repo, p.path) : undefined;
}

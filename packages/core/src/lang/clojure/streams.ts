import type { TokenStreams } from "../index.js";
import { definedName } from "./facts.js";
import { type Coll, type Form, readForms } from "./reader.js";
import { ScopeWalk } from "./scope.js";

/**
 * Token streams and embedding text of Clojure (spec section 17), from the reader's forms. The exact stream holds the
 * collection kinds, keywords and literal values in source order with locals renamed `$1, $2…` in order of first
 * appearance; the shape stream holds the collection kinds only, with symbols, keywords, strings and numbers reduced to
 * `ID`, `KW`, `STR` and `NUM`. Comments and discarded forms never reach either stream.
 */

interface Range {
  start: number;
  end: number;
}

/** The forms of the file the last call read: a symbol's streams and its embedding text come from one read. */
let cache: { source: string; forms: Form[]; comments: { s: number; e: number }[] } | null = null;

function readOf(source: string): { forms: Form[]; comments: { s: number; e: number }[] } {
  if (cache?.source === source) return cache;
  const r = readForms(source);
  cache = { source, forms: r.forms, comments: r.comments };
  return cache;
}

/** The form whose range is exactly `r`, at any depth. */
function locate(forms: readonly Form[], r: Range): Form | null {
  for (const f of forms) {
    if (f.s === r.start && f.e === r.end) return f;
    if (f.s <= r.start && f.e >= r.end && "items" in f) {
      const found = locate(f.items, r);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The names bound anywhere inside `f` (parameters, `let` names, destructuring), and the name it defines. A symbol without
 * a namespace spelled like one of them is a local, in a binding position or not.
 */
function localsOf(f: Form): { names: Set<string>; own: string } {
  const names = new Set<string>();
  const def = f.t === "list" ? definedName(f as Coll) : null;
  const walk = new ScopeWalk(
    () => {},
    (env) => {
      for (const n of env) names.add(n);
    },
  );
  if (def) walk.definition({ form: f as Coll, role: def.head.name === "defmethod" ? "defmethod" : "def" });
  else walk.form(f, new Set(), false);
  return { names, own: def?.name.name ?? "" };
}

const isLocal = (names: ReadonlySet<string>, x: { ns?: string; name: string }): boolean =>
  x.ns === undefined && names.has(x.name);

const COLL: Record<string, string> = { list: "(", vec: "[", map: "{", set: "#{", rcond: "#?(" };

function analyze(f: Form): TokenStreams {
  const exact: string[] = [];
  const shape: string[] = [];
  const selfRefs: number[] = [];
  const { names, own } = localsOf(f);
  const numbered = new Map<string, number>();
  const walk = (x: Form): void => {
    switch (x.t) {
      case "sym": {
        const text = x.ns === undefined ? x.name : `${x.ns}/${x.name}`;
        if (isLocal(names, x)) {
          let k = numbered.get(text);
          if (k === undefined) {
            k = numbered.size + 1;
            numbered.set(text, k);
          }
          exact.push(`$${k}`);
        } else {
          if (own !== "" && text === own) selfRefs.push(exact.length);
          exact.push(`I:${text}`);
        }
        shape.push("ID");
        return;
      }
      case "kw":
        exact.push(`K:${x.text}`);
        shape.push("KW");
        return;
      case "str":
      case "char":
        exact.push(`S:${x.text}`);
        shape.push("STR");
        return;
      case "num":
        exact.push(`N:${x.text}`);
        shape.push("NUM");
        return;
      case "other":
        exact.push(x.text);
        shape.push("OTHER");
        return;
      case "quote":
        exact.push("'");
        shape.push("'");
        for (const y of x.items) walk(y);
        return;
      default: {
        const open = x.anon ? "#(" : (COLL[x.t] as string);
        exact.push(open);
        shape.push(open);
        for (const y of x.items) walk(y);
        exact.push(")");
        shape.push(")");
      }
    }
  };
  walk(f);
  return { exact, shape, selfRefs };
}

/** Token streams of the form in `range` of `source`; empty when no form has exactly that range. */
export function clojureStreams(source: string, range: Range): TokenStreams {
  const f = locate(readOf(source).forms, range);
  return f ? analyze(f) : { exact: [], shape: [], selfRefs: [] };
}

/**
 * Embedding text (spec section 17): the form's source with comments dropped, whitespace collapsed, the form's own name
 * and its locals renamed `v1, v2…` in order of first appearance, and strings replaced by `"s"`. Other names are kept.
 */
export function clojureEmbeddingText(source: string, range: Range): string {
  const r = readOf(source);
  const f = locate(r.forms, range);
  if (!f) return source.slice(range.start, range.end).replace(/\s+/g, " ").trim();
  const { names, own } = localsOf(f);
  const numbered = new Map<string, number>();
  const edits: { start: number; end: number; text: string }[] = [];
  for (const c of r.comments)
    if (c.s >= range.start && c.e <= range.end) edits.push({ start: c.s, end: c.e, text: " " });
  const walk = (x: Form): void => {
    if (x.t === "sym") {
      const name = x.ns === undefined ? x.name : `${x.ns}/${x.name}`;
      if (!isLocal(names, x) && name !== own) return;
      let k = numbered.get(name);
      if (k === undefined) {
        k = numbered.size + 1;
        numbered.set(name, k);
      }
      edits.push({ start: x.s, end: x.e, text: `v${k}` });
    } else if (x.t === "str") edits.push({ start: x.s, end: x.e, text: '"s"' });
    else if ("items" in x) for (const y of x.items) walk(y);
  };
  walk(f);
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let pos = range.start;
  for (const e of edits) {
    if (e.start < pos) continue;
    out += `${source.slice(pos, e.start)}${e.text}`;
    pos = e.end;
  }
  out += source.slice(pos, range.end);
  return out.replace(/\s+/g, " ").trim();
}

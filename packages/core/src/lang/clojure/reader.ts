/**
 * The Clojure reader (spec section 7, Clojure kinds): source text to forms with their source offsets, written by hand,
 * with no grammar and no dependency. It reads lists, vectors, maps and sets, strings, characters, numbers, keywords and
 * symbols, quote (`'x` is a form of its own, whose symbols are not references), syntax-quote, unquote and deref (read
 * through), metadata (kept on the form it precedes), `#_` (the next form is dropped), reader conditionals `#?` and `#?@`
 * (every branch is kept), anonymous functions `#(...)`, regular expressions, var quotes, namespaced maps and tagged
 * literals. Offsets are UTF-16 string offsets: `source.slice(s, e)` is the text of a form. The reader never throws: an
 * unclosed collection ends at the end of the text and is marked, a stray closing bracket is skipped and counted.
 */

/** A collection: `list` `(...)`, `vec` `[...]`, `map` `{...}`, `set` `#{...}`, and `rcond`, a reader conditional. */
export interface Coll {
  t: "list" | "vec" | "map" | "set" | "rcond";
  items: Form[];
  s: number;
  e: number;
  /** `#(...)`: an anonymous function, whose `%` names are its parameters. */
  anon?: true;
  /** A reader conditional: the feature keyword of each item of `items`, in order (`:clj`, `:cljs`, `:default`). */
  features?: string[];
  /** `#?@`: the branches are spliced into the collection around. */
  splice?: true;
  meta?: Form[];
}

/** A symbol: `name`, or `ns/name` with its namespace part. */
export interface Sym {
  t: "sym";
  name: string;
  ns?: string;
  s: number;
  e: number;
  meta?: Form[];
}

/** A keyword, string, regular expression, number, character or anything else read as one token. */
export interface Atom {
  t: "kw" | "str" | "num" | "char" | "other";
  text: string;
  s: number;
  e: number;
  meta?: Form[];
}

/** `'x` (and `(quote x)` as a list): what it holds is data, not code. */
export interface Quote {
  t: "quote";
  items: Form[];
  s: number;
  e: number;
  meta?: Form[];
}

export type Form = Coll | Sym | Atom | Quote;

export interface ReadResult {
  forms: Form[];
  /** Problems of the text: an unclosed collection or string, a stray closing bracket. */
  errors: { offset: number; message: string }[];
  /** Ranges of the comments (`;` to the end of the line, `#!`), for the token streams. */
  comments: { s: number; e: number }[];
}

const DELIMS = new Set([" ", "\t", "\n", "\r", ",", "(", ")", "[", "]", "{", "}", '"', ";", "\f"]);
const CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const NUMBER = /^[+-]?\d/;

/** Reads every top-level form of `src`. */
export function readForms(src: string): ReadResult {
  let i = 0;
  const n = src.length;
  const errors: ReadResult["errors"] = [];
  const comments: ReadResult["comments"] = [];

  const skipSpace = (): void => {
    for (;;) {
      const c = src[i];
      if (c === ";" || (c === "#" && src[i + 1] === "!")) {
        const s = i;
        while (i < n && src[i] !== "\n") i++;
        comments.push({ s, e: i });
      } else if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "," || c === "\f") i++;
      else return;
    }
  };

  const token = (): string => {
    const s = i;
    while (i < n && !DELIMS.has(src[i] as string)) i++;
    return src.slice(s, i);
  };

  const coll = (t: Coll["t"], open: string, s: number): Coll => {
    const close = CLOSE[open] as string;
    i++; // the opening bracket
    const items: Form[] = [];
    for (;;) {
      skipSpace();
      if (i >= n) {
        errors.push({ offset: s, message: `unclosed ${open}` });
        break;
      }
      const c = src[i] as string;
      if (c === close) {
        i++;
        break;
      }
      if (c === ")" || c === "]" || c === "}") {
        errors.push({ offset: i, message: `unexpected ${c}` });
        i++;
        continue;
      }
      const f = form();
      if (f) items.push(f);
    }
    return { t, items, s, e: i };
  };

  const string = (s: number, t: "str"): Atom => {
    i++; // the opening quote
    while (i < n && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
    if (i >= n) errors.push({ offset: s, message: "unclosed string" });
    else i++;
    return { t, text: src.slice(s, Math.min(i, n)), s, e: Math.min(i, n) };
  };

  /** The next form, or null when the text ends or the form is discarded. */
  function form(): Form | null {
    skipSpace();
    if (i >= n) return null;
    const s = i;
    const c = src[i] as string;
    // A closing bracket ends the collection around; it is not consumed here (`[a #_b]`, `'` at the end of a list).
    if (c === ")" || c === "]" || c === "}") return null;
    if (c === "(") return coll("list", "(", s);
    if (c === "[") return coll("vec", "[", s);
    if (c === "{") return coll("map", "{", s);
    if (c === '"') return string(s, "str");
    if (c === "\\") {
      i += 2; // a character literal: the backslash and at least one character, which may be a delimiter
      token();
      return { t: "char", text: src.slice(s, i), s, e: i };
    }
    if (c === "'") {
      i++;
      const f = form();
      return { t: "quote", items: f ? [f] : [], s, e: f ? f.e : i };
    }
    if (c === "`" || c === "@") {
      i++;
      return form();
    }
    if (c === "~") {
      i += src[i + 1] === "@" ? 2 : 1;
      return form();
    }
    if (c === "^") {
      i++;
      const m = form();
      const f = form();
      if (f && m) f.meta = [m, ...(f.meta ?? [])];
      return f;
    }
    if (c === "#") return dispatch(s);
    const tk = token();
    if (tk === "") {
      i++; // a character no form starts with (cannot happen: every delimiter is handled above)
      return null;
    }
    if (tk.startsWith(":")) return { t: "kw", text: tk, s, e: i };
    if (NUMBER.test(tk)) return { t: "num", text: tk, s, e: i };
    const slash = tk.length > 1 ? tk.indexOf("/") : -1;
    return slash > 0
      ? { t: "sym", ns: tk.slice(0, slash), name: tk.slice(slash + 1), s, e: i }
      : { t: "sym", name: tk, s, e: i };
  }

  /** Drops the next form; `#_ #_ a b` drops both `a` and `b`. */
  function discard(): void {
    for (;;) {
      skipSpace();
      if (src[i] === "#" && src[i + 1] === "_") {
        i += 2;
        discard();
        continue;
      }
      form();
      return;
    }
  }

  /** A form that starts with `#`. */
  function dispatch(s: number): Form | null {
    const d = src[i + 1];
    if (d === "(") {
      i++;
      const l = coll("list", "(", s);
      l.anon = true;
      return l;
    }
    if (d === "{") {
      i++;
      return coll("set", "{", s);
    }
    if (d === '"') {
      i++;
      const r = string(i, "str");
      return { ...r, s };
    }
    if (d === "_") {
      i += 2;
      discard(); // the form after it is read by the caller
      return null;
    }
    if (d === "'") {
      i += 2; // a var quote reads as the symbol it names: a reference
      return form();
    }
    if (d === "^") {
      i += 2;
      const m = form();
      const f = form();
      if (f && m) f.meta = [m, ...(f.meta ?? [])];
      return f;
    }
    if (d === "?") {
      const splice = src[i + 2] === "@";
      i += splice ? 3 : 2;
      skipSpace();
      if (src[i] !== "(") return { t: "other", text: src.slice(s, i), s, e: i };
      const l = coll("rcond", "(", s);
      const features: string[] = [];
      const items: Form[] = [];
      for (let k = 0; k + 1 < l.items.length; k += 2) {
        const key = l.items[k] as Form;
        features.push(key.t === "kw" ? key.text : "");
        items.push(l.items[k + 1] as Form);
      }
      l.items = items;
      l.features = features;
      if (splice) l.splice = true;
      return l;
    }
    if (d === ":") {
      i++; // a namespaced map: `#:a{...}` reads as the map
      token();
      return form();
    }
    if (d === "#") {
      i += 2; // `##Inf`, `##NaN`
      token();
      return { t: "num", text: src.slice(s, i), s, e: i };
    }
    if (d === "=") {
      i += 2;
      return form();
    }
    i++; // a tagged literal: the tag, then the form it tags
    token();
    return form();
  }

  const forms: Form[] = [];
  while (i < n) {
    skipSpace();
    if (i >= n) break;
    const c = src[i] as string;
    if (c === ")" || c === "]" || c === "}") {
      errors.push({ offset: i, message: `unexpected ${c}` });
      i++;
      continue;
    }
    const f = form();
    if (f) forms.push(f);
  }
  return { forms, errors, comments };
}

/** True for a symbol without a namespace part spelled `name`. */
export const isSym = (f: Form | undefined, name?: string): f is Sym =>
  f?.t === "sym" && f.ns === undefined && (name === undefined || f.name === name);

/** The spelling of a symbol as written: `ns/name` or `name`. */
export const symText = (f: Sym): string => (f.ns === undefined ? f.name : `${f.ns}/${f.name}`);

/** The items of a collection, or none for any other form. */
export const itemsOf = (f: Form | undefined): Form[] =>
  f !== undefined && (f.t === "list" || f.t === "vec" || f.t === "map" || f.t === "set" || f.t === "rcond")
    ? f.items
    : [];

/** The text of a keyword (`:as`), or undefined for any other form. */
export const kwText = (f: Form | undefined): string | undefined => (f?.t === "kw" ? f.text : undefined);

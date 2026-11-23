/**
 * Readers for the configuration manifests of a pack (`workspace.manifests`, formats `toml` and `ini`). They do not
 * validate: they keep, for each dotted path (`project.name`, `options.install_requires`), the strings the key holds in
 * document order (a string value is one entry, an array one entry per string element, an INI value one entry per line),
 * and, for each table path, the names of the keys and sub-tables below it. Values that are not strings (numbers,
 * booleans, inline tables, arrays of arrays) hold no entries; comments are skipped.
 */
export interface ConfigTable {
  /** Strings by dotted path of the key. */
  values: Map<string, string[]>;
  /** Names of the keys and sub-tables of each table, by dotted path of the table (`""` for the root), in document order. */
  keys: Map<string, string[]>;
}

const push = <T>(map: Map<string, T[]>, key: string, value: T): void => {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
};

const addKey = (keys: Map<string, string[]>, table: string, name: string): void => {
  const list = keys.get(table) ?? [];
  if (!list.includes(name)) list.push(name);
  keys.set(table, list);
};

const BARE = /[A-Za-z0-9_-]/;

/** Reads a TOML document (tables, array tables, dotted and quoted keys, basic, literal and multi-line strings, arrays). */
export function readToml(text: string): ConfigTable {
  const values = new Map<string, string[]>();
  const keys = new Map<string, string[]>();
  const n = text.length;
  let i = 0;
  let table: string[] = [];

  const skipLine = (): void => {
    while (i < n && text[i] !== "\n") i++;
  };
  const skipBlank = (): void => {
    while (i < n && /\s/.test(text.charAt(i))) i++;
  };
  const skipSpace = (): void => {
    while (i < n && (text[i] === " " || text[i] === "\t")) i++;
  };
  /** A quoted string at `i`; null when none starts there. */
  const quoted = (): string | null => {
    const q = text.charAt(i);
    if (q !== '"' && q !== "'") return null;
    const triple = text.startsWith(q.repeat(3), i);
    if (triple) {
      const end = text.indexOf(q.repeat(3), i + 3);
      const body = text.slice(i + 3, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
      return body;
    }
    i++;
    let out = "";
    while (i < n && text[i] !== q && text[i] !== "\n") {
      if (q === '"' && text[i] === "\\") {
        out += text.charAt(i + 1);
        i += 2;
      } else out += text.charAt(i++);
    }
    if (text[i] === q) i++;
    return out;
  };
  /** A dotted key at `i`: its segments. */
  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skipSpace();
      const q = quoted();
      if (q !== null) parts.push(q);
      else {
        const start = i;
        while (i < n && BARE.test(text.charAt(i))) i++;
        if (i === start) break;
        parts.push(text.slice(start, i));
      }
      skipSpace();
      if (text[i] === ".") i++;
      else break;
    }
    return parts;
  };
  /** Skips a balanced `[...]` or `{...}` value without keeping anything of it. */
  const skipBalanced = (): void => {
    let depth = 0;
    while (i < n) {
      const c = text.charAt(i);
      if (c === '"' || c === "'") quoted();
      else if (c === "#") skipLine();
      else {
        i++;
        if (c === "[" || c === "{") depth++;
        else if ((c === "]" || c === "}") && --depth === 0) return;
      }
    }
  };
  /** The strings of a value at `i`. */
  const value = (): string[] => {
    skipSpace();
    const c = text.charAt(i);
    if (c === '"' || c === "'") {
      const s = quoted();
      return s === null ? [] : [s];
    }
    if (c === "[") {
      const out: string[] = [];
      i++;
      for (;;) {
        skipBlank();
        const d = text.charAt(i);
        if (i >= n || d === "]") {
          i++;
          return out;
        }
        if (d === "#") skipLine();
        else if (d === ",") i++;
        else if (d === '"' || d === "'") {
          const s = quoted();
          if (s !== null) out.push(s);
        } else if (d === "[" || d === "{") skipBalanced();
        else while (i < n && !/[\s,\]]/.test(text.charAt(i))) i++;
      }
    }
    if (c === "{") {
      skipBalanced();
      return [];
    }
    // A number, a boolean or a date holds no string.
    while (i < n && text[i] !== "\n" && text[i] !== "#") i++;
    return [];
  };

  while (i < n) {
    skipBlank();
    if (i >= n) break;
    const c = text.charAt(i);
    if (c === "#") {
      skipLine();
      continue;
    }
    if (c === "[") {
      const array = text[i + 1] === "[";
      i += array ? 2 : 1;
      table = key();
      skipSpace();
      while (i < n && text[i] !== "\n" && text[i] !== "#") i++;
      for (let k = 0; k < table.length; k++) addKey(keys, table.slice(0, k).join("."), table[k] ?? "");
      continue;
    }
    const k = key();
    if (k.length === 0) {
      skipLine();
      continue;
    }
    skipSpace();
    if (text[i] !== "=") {
      skipLine();
      continue;
    }
    i++;
    const path = [...table, ...k];
    for (let j = table.length; j < path.length; j++) addKey(keys, path.slice(0, j).join("."), path[j] ?? "");
    for (const v of value()) push(values, path.join("."), v);
    skipSpace();
    if (text[i] === "#") skipLine();
  }
  return { values, keys };
}

/** Reads an INI document (`[section]`, `key = value` or `key: value`, indented continuation lines, `#` and `;` comments). */
export function readIni(text: string): ConfigTable {
  const values = new Map<string, string[]>();
  const keys = new Map<string, string[]>();
  let section = "";
  let last: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*[#;]/.test(raw) || raw.trim() === "") continue;
    const head = /^\[([^\]]+)\]\s*$/.exec(raw);
    if (head) {
      section = (head[1] ?? "").trim();
      last = null;
      addKey(keys, "", section);
      continue;
    }
    if (/^\s/.test(raw) && last !== null) {
      push(values, last, raw.trim());
      continue;
    }
    const kv = /^([^=:\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(raw);
    if (!kv) {
      last = null;
      continue;
    }
    const name = (kv[1] ?? "").trim();
    last = section === "" ? name : `${section}.${name}`;
    addKey(keys, section, name);
    if ((kv[2] ?? "").trim() !== "") push(values, last, (kv[2] ?? "").trim());
    else if (!values.has(last)) values.set(last, []);
  }
  return { values, keys };
}

/** Reads a manifest in the given format. */
export const readConfig = (text: string, format: "toml" | "ini"): ConfigTable =>
  format === "toml" ? readToml(text) : readIni(text);

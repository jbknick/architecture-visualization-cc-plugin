/**
 * Helper `sql-text`: table names, and whether SQL reads or writes them, from SQL held in text. The text comes from a
 * string, a template literal, a tagged template or a `.sql` file; the caller turns each substitution of a template
 * into a placeholder (`placeholder(i)`) so a table named by a substitution can be told from one named in the text.
 *
 * `SELECT ... FROM` and `JOIN` read; `INSERT INTO`, `UPDATE`, `DELETE FROM` and `TRUNCATE` write; `CREATE TABLE` only
 * declares. A name defined by a `WITH` clause is not a table, and an alias after a table name is skipped. The helper
 * knows SQL and nothing else: no ORM, driver or framework name appears here.
 */

export type SqlKind = "read" | "write" | "create";

export interface SqlRef {
  kind: SqlKind;
  /** The table reference as written, possibly schema-qualified (`public.job`) or holding placeholders. */
  ref: string;
  /** Offset of the reference in the cleaned text (same length as the input, so line numbers carry over). */
  offset: number;
}

export const placeholder = (i: number): string => `\u0001${i}\u0002`;
const PH = "\\u0001\\d+\\u0002";
const ID = `(?:"[^"]+"|\`[^\`]+\`|${PH}|[A-Za-z_][A-Za-z0-9_$]*)`;
const REF = `${ID}(?:\\s*\\.\\s*${ID})*`;
const FLAGS = "gi";

const createRx = () =>
  new RegExp(
    `\\bCREATE\\s+(?:(?:GLOBAL|LOCAL)\\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED)\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${REF})`,
    FLAGS,
  );
const insertRx = () => new RegExp(`\\bINSERT\\s+INTO\\s+(${REF})`, FLAGS);
const updateRx = () =>
  new RegExp(`\\bUPDATE\\s+(?:ONLY\\s+)?(${REF})(?:\\s+(?:AS\\s+)?[A-Za-z_]\\w*)?\\s+SET\\b`, FLAGS);
const deleteRx = () => new RegExp(`\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?(${REF})`, FLAGS);
const truncateRx = () => new RegExp(`\\bTRUNCATE\\s+(?:TABLE\\s+)?(?:ONLY\\s+)?(${REF})`, FLAGS);
const fromRx = () => new RegExp(`\\b(FROM|JOIN)\\s+(?:LATERAL\\s+)?(${REF})`, FLAGS);
const cteRx = () => /\b([A-Za-z_]\w*)\s*(?:\([^()]*\))?\s+AS\s+(?:NOT\s+)?(?:MATERIALIZED\s+)?\(/gi;
const aliasStop =
  /^(?:\s+(?:AS\s+)?(?!(?:WHERE|JOIN|LEFT|RIGHT|INNER|FULL|CROSS|ON|GROUP|ORDER|LIMIT|UNION|SET|USING|OFFSET|HAVING|FOR|RETURNING|WINDOW|EXCEPT|INTERSECT|NATURAL|LATERAL|SELECT)\b)[A-Za-z_]\w*)?\s*,\s*/i;
const idRx = () => new RegExp(ID, "g");

/** A text is SQL when it holds a statement shape anywhere, so a parenthesized subquery or a CTE fragment counts. */
const SQL_SHAPE =
  /\bSELECT\b[\s\S]*?\bFROM\b|\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bUPDATE\b[\s\S]*?\bSET\b|\bCREATE\s+(?:[A-Z]+\s+)*TABLE\b|\bTRUNCATE\b/i;

/** Blanks comments and string literals, keeping every offset and newline. */
export function cleanSql(text: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, " ");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/--[^\n]*/g, blank)
    .replace(/'(?:[^']|'')*'/g, (s) => `'${blank(s.slice(1, -1))}'`);
}

export const looksLikeSql = (text: string): boolean =>
  SQL_SHAPE.test(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, ""));

const lineOfIndex = (t: string, off: number): number => {
  let n = 0;
  for (let i = 0; i < off && i < t.length; i++) if (t.charCodeAt(i) === 10) n++;
  return n;
};
/** Zero-based line of an offset in `text`. */
export const lineInText = lineOfIndex;

/** Every table reference of a SQL text, in source order of the statement kinds. */
export function scanSql(input: string): SqlRef[] {
  const text = cleanSql(input);
  const ctes = new Set<string>();
  for (const m of text.matchAll(cteRx())) ctes.add((m[1] as string).toLowerCase());
  const out: SqlRef[] = [];
  const add = (kind: SqlKind, ref: string, offset: number): void => {
    const segs = ref.match(idRx()) ?? [];
    if (segs.length === 1 && ctes.has((segs[0] as string).toLowerCase())) return;
    out.push({ kind, ref, offset });
  };
  for (const m of text.matchAll(createRx())) add("create", m[1] as string, m.index ?? 0);
  for (const rx of [insertRx(), updateRx(), deleteRx(), truncateRx()])
    for (const m of text.matchAll(rx)) add("write", m[1] as string, m.index ?? 0);
  for (const m of text.matchAll(fromRx())) {
    const idx = m.index ?? 0;
    if (/DELETE\s+$/i.test(text.slice(Math.max(0, idx - 12), idx))) continue;
    const end = idx + m[0].length;
    if (/^\s*\(/.test(text.slice(end))) continue; // a function call, not a table
    add("read", m[2] as string, idx);
    if (m[1]?.toUpperCase() !== "FROM") continue;
    // `FROM a x, b y`: the comma-separated tables after an optional alias.
    let rest = text.slice(end);
    let base = end;
    for (;;) {
      const lead = aliasStop.exec(rest);
      if (!lead) break;
      const after = rest.slice(lead[0].length);
      const mm = new RegExp(`^(${REF})`, "i").exec(after);
      if (!mm || /^\s*\(/.test(after.slice(mm[0].length))) break;
      add("read", mm[1] as string, base + lead[0].length);
      const adv = lead[0].length + mm[0].length;
      rest = rest.slice(adv);
      base += adv;
    }
  }
  return out;
}

/** The last segment of a reference: a literal name, or the index of the placeholder that stands for it. */
export function refTarget(ref: string): { name: string } | { placeholder: number } | null {
  const segs = ref.match(idRx()) ?? [];
  const last = segs[segs.length - 1];
  if (!last) return null;
  if (last.startsWith("\u0001")) return { placeholder: Number(last.slice(1, -1)) };
  return { name: last.replace(/^["`]|["`]$/g, "") };
}

// American English word check (used by american-english.test.ts). One place holds the converted words and the
// way text a person reads is pulled out of each file kind: prose files whole, source files only in comments,
// string and template literals and JSX text (never identifiers), JSON files in string values only.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { parseSync } from "oxc-parser";

const root = resolve(import.meta.dirname, "..");

/** British spelling to American spelling. Exact word forms; case is carried over. */
export const WORDS: Record<string, string> = {};
const add = (british: string, american: string): void => {
  WORDS[british] = american;
};
for (const [stem, us] of [
  ["organis", "organiz"],
  ["visualis", "visualiz"],
  ["initialis", "initializ"],
  ["finalis", "finaliz"],
  ["normalis", "normaliz"],
  ["recognis", "recogniz"],
  ["summaris", "summariz"],
  ["prioritis", "prioritiz"],
  ["serialis", "serializ"],
  ["sanitis", "sanitiz"],
  ["generalis", "generaliz"],
  ["authoris", "authoriz"],
  ["optimis", "optimiz"],
  ["neutralis", "neutraliz"],
  ["penalis", "penaliz"],
  ["pluralis", "pluraliz"],
  ["materialis", "materializ"],
  ["tokenis", "tokeniz"],
  ["parenthesis", "parenthesiz"],
  ["capitalis", "capitaliz"],
  ["emphasis", "emphasiz"],
  ["memoris", "memoriz"],
  ["minimis", "minimiz"],
  ["maximis", "maximiz"],
  ["realis", "realiz"],
  ["utilis", "utiliz"],
  ["customis", "customiz"],
  ["synchronis", "synchroniz"],
  ["standardis", "standardiz"],
  ["specialis", "specializ"],
  ["localis", "localiz"],
  ["characteris", "characteriz"],
  ["categoris", "categoriz"],
  ["randomis", "randomiz"],
  ["stabilis", "stabiliz"],
  ["virtualis", "virtualiz"],
  ["itemis", "itemiz"],
  ["mobilis", "mobiliz"],
  ["centralis", "centraliz"],
  ["criticis", "criticiz"],
  ["apologis", "apologiz"],
] as const) {
  for (const suffix of ["e", "ed", "es", "ing", "ation", "ations", "er", "ers", "able"]) {
    // "emphasis", "parenthesis" and "analysis" are nouns in both spellings; only the verb forms change.
    add(stem + suffix, us + suffix);
  }
}
for (const [b, a] of [
  ["organisation", "organization"],
  ["colour", "color"],
  ["colours", "colors"],
  ["coloured", "colored"],
  ["colouring", "coloring"],
  ["colourful", "colorful"],
  ["behaviour", "behavior"],
  ["behaviours", "behaviors"],
  ["behavioural", "behavioral"],
  ["analyse", "analyze"],
  ["analysed", "analyzed"],
  ["analyses", "analyzes"],
  ["analysing", "analyzing"],
  ["cancelled", "canceled"],
  ["cancelling", "canceling"],
  ["favour", "favor"],
  ["favours", "favors"],
  ["favoured", "favored"],
  ["centre", "center"],
  ["centres", "centers"],
  ["centred", "centered"],
  ["catalogue", "catalog"],
  ["catalogues", "catalogs"],
  ["artefact", "artifact"],
  ["artefacts", "artifacts"],
  ["labelled", "labeled"],
  ["labelling", "labeling"],
  ["labeller", "labeler"],
  ["unlabelled", "unlabeled"],
  ["modelled", "modeled"],
  ["modelling", "modeling"],
  ["neighbour", "neighbor"],
  ["neighbours", "neighbors"],
  ["neighbouring", "neighboring"],
  ["neighbourhood", "neighborhood"],
  ["honour", "honor"],
  ["honours", "honors"],
  ["honoured", "honored"],
  ["honouring", "honoring"],
  ["flavoured", "flavored"],
  ["defence", "defense"],
  ["offence", "offense"],
  ["licence", "license"],
  ["licences", "licenses"],
  ["analogue", "analog"],
  ["recolour", "recolor"],
  ["recolours", "recolors"],
  ["grey", "gray"],
  ["greyed", "grayed"],
  ["greys", "grays"],
  ["whilst", "while"],
  ["amongst", "among"],
  ["judgement", "judgment"],
  ["programme", "program"],
  ["programmes", "programs"],
] as const) {
  add(b, a);
}
delete WORDS.analyses; // "analyses" is the plural noun of "analysis"; only the verb form was meant, which reads the same
delete WORDS.realise;
delete WORDS.realiser;
delete WORDS.realisers;
delete WORDS.realisable;

const alt = Object.keys(WORDS)
  .sort((a, b) => b.length - a.length)
  .join("|");
/** Matches a converted word on word boundaries (also not inside `snake_case` or `kebab-free` identifiers). */
export const WORD_RE = new RegExp(`(?<![A-Za-z0-9_$])(${alt})(?![A-Za-z0-9_$])`, "gi");
const FOREVER_RE = /\bfor ever\b/gi;

/** `cancelled()` is a GitHub Actions expression function; its name is a contract. */
function isException(text: string, match: RegExpMatchArray): boolean {
  const word = match[0].toLowerCase();
  const after = text.slice((match.index ?? 0) + match[0].length);
  return word === "cancelled" && after.startsWith("()");
}

function carryCase(from: string, to: string): string {
  if (from.length > 1 && from === from.toUpperCase()) return to.toUpperCase();
  if (from[0] === from[0]?.toUpperCase()) return (to[0] ?? "").toUpperCase() + to.slice(1);
  return to;
}

export interface Hit {
  word: string;
  index: number;
}

/** Every British word in `text`, as written, with its offset. */
export function findWords(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    if (isException(text, m)) continue;
    hits.push({ word: m[0], index: m.index ?? 0 });
  }
  for (const m of text.matchAll(FOREVER_RE)) hits.push({ word: m[0], index: m.index ?? 0 });
  return hits.sort((a, b) => a.index - b.index);
}

/** `text` with every British word converted. */
export function convert(text: string): string {
  return text
    .replace(WORD_RE, (w, _g, offset: number, whole: string) => {
      const m = Object.assign([w], { index: offset }) as unknown as RegExpMatchArray;
      if (isException(whole, m)) return w;
      return carryCase(w, WORDS[w.toLowerCase()] as string);
    })
    .replace(FOREVER_RE, (w) => carryCase(w, "forever"));
}

export type Range = [start: number, end: number];

const SOURCE = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs"]);
const SKIP_ATTRS = new Set([
  "className",
  "id",
  "htmlFor",
  "key",
  "role",
  "type",
  "name",
  "href",
  "src",
  "to",
  "d",
]);

interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

/** Ranges of the text a person reads in a TypeScript or JavaScript file. */
export function sourceRanges(file: string, text: string): Range[] {
  const { program, comments } = parseSync(file, text);
  const out: Range[] = comments.map((c) => [c.start, c.end] as Range);
  const visit = (node: unknown, parent: AstNode | null, key: string): void => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n, parent, key);
      return;
    }
    if (!node || typeof node !== "object") return;
    const n = node as AstNode;
    if (typeof n.type !== "string") return;
    if (n.type === "Literal" && typeof n.value === "string") {
      if (literalOk(parent, key)) out.push([n.start, n.end]);
    } else if (n.type === "TemplateElement" || n.type === "JSXText") {
      out.push([n.start, n.end]);
    }
    for (const [k, v] of Object.entries(n)) if (k !== "type" && typeof v === "object") visit(v, n, k);
  };
  visit(program, null, "");
  return out.sort((a, b) => a[0] - b[0]);
}

/** A string literal is read by a person unless it is a key, a module path, a compared token or a markup attribute that names things. */
function literalOk(parent: AstNode | null, key: string): boolean {
  if (!parent) return true;
  switch (parent.type) {
    case "Property":
    case "PropertyDefinition":
    case "MethodDefinition":
    case "TSPropertySignature":
      return key !== "key";
    case "MemberExpression":
      return key !== "property";
    case "ImportDeclaration":
    case "ExportAllDeclaration":
    case "ExportNamedDeclaration":
    case "ImportExpression":
    case "TSLiteralType":
    case "TSExternalModuleReference":
    case "TSImportType":
    case "SwitchCase":
    case "TSEnumMember":
    case "ImportSpecifier":
    case "ExportSpecifier":
      return false;
    case "BinaryExpression":
      return !["===", "!==", "==", "!="].includes(String(parent.operator));
    case "JSXAttribute": {
      const name = String((parent.name as { name?: unknown }).name ?? "");
      return !(SKIP_ATTRS.has(name) || name.startsWith("data-"));
    }
    case "CallExpression":
      return !((parent.callee as { name?: string }).name === "require");
    default:
      return true;
  }
}

/** Ranges of string values of a JSON document (keys are never text a person reads). */
export function jsonRanges(text: string): Range[] {
  const out: Range[] = [];
  for (const m of text.matchAll(/"((?:[^"\\\n]|\\.)*)"(\s*:)?/g)) {
    if (m[2]) continue;
    out.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  return out;
}

/** Ranges of comments in a CSS file. */
export function cssRanges(text: string): Range[] {
  return [...text.matchAll(/\/\*[\s\S]*?\*\//g)].map(
    (m) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as Range,
  );
}

/** Ranges of text a person reads in `file`, or `null` when the whole file is text. */
export function textRanges(file: string, text: string): Range[] | null {
  const ext = extname(file);
  if (SOURCE.has(ext)) return sourceRanges(file, text);
  if (ext === ".json") return jsonRanges(text);
  if (ext === ".css") return cssRanges(text);
  return null;
}

/** Tracked files whose text a person reads: README and docs, plugin markdown, CLI and MCP messages, explorer copy, comments. */
export function filesInScope(): string[] {
  const listed = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const kinds = new Set([
    ".md",
    ".ts",
    ".tsx",
    ".json",
    ".css",
    ".snap",
    ".sh",
    ".yml",
    ".yaml",
    ".html",
    ".txt",
    ".toml",
  ]);
  return listed
    .split("\0")
    .filter(Boolean)
    .filter((f) => kinds.has(extname(f)))
    .filter((f) => !/(^|\/)(fixtures|testdata|evals|dist|node_modules)\//.test(f))
    .filter((f) => !/(^|\/)(pnpm-lock\.yaml|package-lock\.json|CHANGELOG\.md)$/.test(f))
    .filter(
      (f) =>
        f !== "scripts/american-english.ts" &&
        f !== "scripts/american-english.test.ts" &&
        f !== "scripts/american-english.allow.txt",
    );
}

export function read(file: string): string {
  return readFileSync(resolve(root, file), "utf8");
}

/** Hits in `file` that a person would read (identifiers in code are not scanned). */
export function scanFile(file: string, text: string): Hit[] {
  const ranges = textRanges(file, text);
  if (!ranges) return findWords(text);
  const hits: Hit[] = [];
  for (const [s, e] of ranges)
    for (const h of findWords(text.slice(s, e))) hits.push({ word: h.word, index: s + h.index });
  return hits;
}

/** `text` of `file` with every British word in the text a person reads converted. */
export function convertFile(file: string, text: string): string {
  const ranges = textRanges(file, text);
  if (!ranges) return convert(text);
  let out = text;
  for (const [s, e] of [...ranges].sort((a, b) => b[0] - a[0]))
    out = out.slice(0, s) + convert(out.slice(s, e)) + out.slice(e);
  return out;
}

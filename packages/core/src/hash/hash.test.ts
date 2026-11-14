import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseSource } from "../parse/index.js";
import { hashSymbol, minhashJaccard, normalizeForEmbedding } from "./index.js";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures");

const whole = (s: string) => ({ start: 0, end: s.length });
const h = (s: string, lang: "ts" | "tsx" = "ts") => hashSymbol(s, whole(s), lang);

function fixtureSymbol(rel: string, name: string) {
  const source = readFileSync(join(fixturesRoot, rel), "utf8");
  const parsed = parseSource(rel, source);
  const sym = parsed.symbols.find((s) => s.name === name);
  if (!sym) throw new Error(`no symbol ${name}`);
  const range = parsed.bodies.get(sym.id);
  if (!range) throw new Error(`no body for ${name}`);
  return { source, range, ...hashSymbol(source, range, "ts") };
}

const BASE = `export function total(items: Item[], tax: number): number {
  let sum = 0;
  for (const item of items) {
    sum += item.price * item.qty;
  }
  return sum * (1 + tax);
}`;

describe("exactHash", () => {
  test("is 32 hex chars and minhash has 64 slots", () => {
    const r = h(BASE);
    expect(r.exactHash).toMatch(/^[0-9a-f]{32}$/);
    expect(r.shapeHash).toMatch(/^[0-9a-f]{32}$/);
    expect(r.minhash).toBeInstanceOf(Uint32Array);
    expect(r.minhash.length).toBe(64);
  });

  test("renaming locals (params, let, for-of binding) keeps it", () => {
    const renamed = BASE.replace(/\bitems\b/g, "rows")
      .replace(/\btax\b/g, "rate")
      .replace(/\bsum\b/g, "acc")
      .replace(/\bitem\b/g, "row");
    expect(h(renamed).exactHash).toBe(h(BASE).exactHash);
  });

  test("renaming the function changes it", () => {
    expect(h(BASE.replace("total", "grandTotal")).exactHash).not.toBe(h(BASE).exactHash);
  });

  test("renaming a property name changes it", () => {
    expect(h(BASE.replace(/item\.price/, "item.cost")).exactHash).not.toBe(h(BASE).exactHash);
  });

  test("changing a string or number literal changes it", () => {
    const a = `function f(x) { return x + 1 + "a"; }`;
    expect(h(a.replace("1", "2")).exactHash).not.toBe(h(a).exactHash);
    expect(h(a.replace('"a"', '"b"')).exactHash).not.toBe(h(a).exactHash);
  });

  test("renaming an imported (non-local) name changes it, a shadowing local does not", () => {
    const a = `function f(x) { return fmt(x); }`;
    expect(h(a.replace("fmt", "format")).exactHash).not.toBe(h(a).exactHash);
    const shadow = `function f(x) { const fmt = 1; return fmt + x; }`;
    expect(h(shadow.replace(/fmt/g, "other")).exactHash).toBe(h(shadow).exactHash);
  });

  test("a local vs a free identifier of the same shape differ", () => {
    expect(h(`function f(a) { return a; }`).exactHash).not.toBe(h(`function f(a) { return b; }`).exactHash);
  });

  test("first-appearance numbering distinguishes parameter order use", () => {
    const x = h(`function f(a, b) { return a - b; }`).exactHash;
    const y = h(`function f(a, b) { return b - a; }`).exactHash;
    expect(x).not.toBe(y);
  });

  test("reformatting, quote style and comments keep all three values", () => {
    const messy = `/** doc */
export   function total( items: Item[],tax: number ): number
{
  // running sum
  let sum = 0 ;
  for ( const item of items ) { /* each */ sum += item.price*item.qty }
  return sum*( 1+tax ) ;
}`;
    const a = h(BASE);
    const b = h(messy);
    expect(b.exactHash).toBe(a.exactHash);
    expect(b.shapeHash).toBe(a.shapeHash);
    expect(Array.from(b.minhash)).toEqual(Array.from(a.minhash));
    const q1 = `function f() { return 'x'; }`;
    const q2 = `function f() { return "x"; }`;
    expect(h(q1).exactHash).toBe(h(q2).exactHash);
  });

  test("export keyword is not part of the hash", () => {
    expect(h(BASE.replace("export ", "")).exactHash).toBe(h(BASE).exactHash);
  });

  test("handles catch params, destructuring, nested functions and block shadowing", () => {
    const src = `function f(input) {
  const { a: aa, b: [c, ...rest], ...others } = input;
  try { risky(aa); } catch (err) { log(err, c, rest, others); }
  const g = (v) => v + aa;
  { let aa = 2; log(aa); }
  return g(c);
}`;
    const renamed = src
      .replace(/\binput\b/g, "arg")
      .replace(/\baa\b/g, "zz")
      .replace(/\bc\b/g, "cc")
      .replace(/\brest\b/g, "others2")
      .replace(/\bothers\b/g, "more")
      .replace(/\berr\b/g, "e")
      .replace(/\bg\b/g, "gg")
      .replace(/\bv\b/g, "w");
    // `b:` is a property name (kept); `risky`/`log` are free (kept).
    expect(h(renamed).exactHash).toBe(h(src).exactHash);
    expect(h(src.replace("risky", "safe")).exactHash).not.toBe(h(src).exactHash);
    expect(h(src.replace("b:", "z:")).exactHash).not.toBe(h(src).exactHash);
  });

  test("var hoisting: a var declared in a nested block is local to the function", () => {
    const src = `function f(n) { if (n) { var tmp = n; } return tmp; }`;
    expect(h(src.replace(/tmp/g, "value")).exactHash).toBe(h(src).exactHash);
  });

  test("`this` and `arguments` are keywords, not locals", () => {
    const a = `function f(x) { return this.v + arguments.length + x; }`;
    expect(h(a.replace(/\bx\b/g, "y")).exactHash).toBe(h(a).exactHash);
    expect(h(a.replace("arguments", "args")).exactHash).not.toBe(h(a).exactHash);
    expect(h(a.replace("this.v", "that.v")).exactHash).not.toBe(h(a).exactHash);
  });

  test("shorthand and explicit properties with the same meaning agree", () => {
    expect(h(`function f(a) { return { a }; }`).exactHash).toBe(
      h(`function f(a) { return { a: a }; }`).exactHash,
    );
    // The key survives renaming the local, so renaming alone changes nothing but key text matters.
    expect(h(`function f(a) { return { k: a }; }`).exactHash).toBe(
      h(`function f(z) { return { k: z }; }`).exactHash,
    );
    expect(h(`function f(a) { return { k: a }; }`).exactHash).not.toBe(
      h(`function f(a) { return { j: a }; }`).exactHash,
    );
  });

  test("generic type parameters are local", () => {
    const a = `function f<T>(x: T): T { return x; }`;
    expect(h(a.replace(/\bT\b/g, "U")).exactHash).toBe(h(a).exactHash);
  });

  test("operator and async/generator flags matter", () => {
    expect(h(`function f(a, b) { return a + b; }`).exactHash).not.toBe(
      h(`function f(a, b) { return a - b; }`).exactHash,
    );
    expect(h(`function f() { return 1; }`).exactHash).not.toBe(
      h(`async function f() { return 1; }`).exactHash,
    );
  });

  test("template literal text matters for exactHash but not shapeHash", () => {
    const a = h(["function f(n) { return `$", "{n}d ago`; }"].join(""));
    const b = h(["function f(n) { return `$", "{n}h ago`; }"].join(""));
    expect(a.exactHash).not.toBe(b.exactHash);
    expect(a.shapeHash).toBe(b.shapeHash);
  });

  test("arrow with expression body, class method and const range", () => {
    const src = `export const add = (a: number, b: number) => a + b;
class Calc {
  mul(x: number, y: number) { return x * y; }
}`;
    const parsed = parseSource("src/calc.ts", src);
    const add = parsed.symbols.find((s) => s.name === "add");
    const mul = parsed.symbols.find((s) => s.name === "Calc.mul");
    if (!add || !mul) throw new Error("symbols missing");
    const ha = hashSymbol(src, parsed.bodies.get(add.id) as { start: number; end: number }, "ts");
    const hm = hashSymbol(src, parsed.bodies.get(mul.id) as { start: number; end: number }, "ts");
    const alt = `export const add = (p: number, q: number) => p + q;`;
    expect(h(alt).exactHash).toBe(ha.exactHash);
    expect(hm.exactHash).not.toBe(ha.exactHash);
    const altMethod = `class Calc {\n  mul(i: number, j: number) {\n return i * j; }\n}`;
    const p2 = parseSource("src/calc.ts", altMethod);
    const m2 = p2.symbols.find((s) => s.name === "Calc.mul");
    if (!m2) throw new Error("mul missing");
    expect(
      hashSymbol(altMethod, p2.bodies.get(m2.id) as { start: number; end: number }, "ts").exactHash,
    ).toBe(hm.exactHash);
  });

  test("tsx: JSX component, intrinsic tags vs components, JSX text layout", () => {
    const a = `export function Card({ title }: P) { return <Box className="c"><h1>{title}</h1>  text  </Box>; }`;
    const b = `export function Card({ title: t }: P) { return (
  <Box className="c">
    <h1>{t}</h1>
    {" "}
  </Box>); }`;
    expect(h(a, "tsx").exactHash).not.toBe(h(b, "tsx").exactHash); // different content
    const c = `export function Card({ title }: P) { return <Box className="c">
  <h1>{title}</h1>
  text
</Box>; }`;
    const d = `export function Card({ title }: P) { return <Box className="c"><h1>{title}</h1>text</Box>; }`;
    expect(h(c, "tsx").exactHash).toBe(h(d, "tsx").exactHash);
    // Renaming a component local keeps the hash; renaming an imported component does not.
    const e = `function A() { const Inner = pick(); return <Inner />; }`;
    expect(h(e.replace(/Inner/g, "Other"), "tsx").exactHash).toBe(h(e, "tsx").exactHash);
    const f = `function A() { return <Inner />; }`;
    expect(h(f.replace(/Inner/g, "Other"), "tsx").exactHash).not.toBe(h(f, "tsx").exactHash);
  });

  test("source ranges that do not start at 0 only hash the symbol", () => {
    const src = `import { a } from "./a";\n\n${BASE}\n\nexport const other = 1;\n`;
    const start = src.indexOf("export function total");
    const end = src.indexOf("\n\nexport const other");
    expect(hashSymbol(src, { start, end }, "ts")).toEqual(h(BASE));
  });

  test("handles unicode before the range (UTF-16 offsets)", () => {
    const src = `// héllo 🎉 wörld\n${BASE}`;
    const start = src.indexOf("export function");
    expect(hashSymbol(src, { start, end: src.length }, "ts").exactHash).toBe(h(BASE).exactHash);
  });

  test("falls back for unparseable input without throwing", () => {
    const r = h("function f( {{{ ");
    expect(r.exactHash).toMatch(/^[0-9a-f]{32}$/);
    expect(h("function f( {{{ ").exactHash).toBe(r.exactHash);
    expect(h("function f( {{{ // c").exactHash).toBe(r.exactHash);
  });

  test("empty range yields all-empty minhash", () => {
    const r = hashSymbol("const a = 1;", { start: 3, end: 3 }, "ts");
    expect(Array.from(r.minhash).every((x) => x === 0xffffffff)).toBe(true);
  });

  test("a method range parses even when the rest of the file does not", () => {
    const src = `class A {\n  run(x) { return x + 1; }\n}\nfunction broken( {{{`;
    const start = src.indexOf("run(");
    const end = src.indexOf("\n}\nfunction");
    const r = hashSymbol(src, { start, end }, "ts");
    expect(r.exactHash).toBe(
      hashSymbol(`class A {\n  run(y) { return y + 1; }\n}`, { start: 12, end: 36 }, "ts").exactHash,
    );
  });
});

describe("shapeHash", () => {
  test("ignores identifiers, strings, numbers", () => {
    const a = h(`function f(a, b) { return a + 1 + "x" + b.c; }`);
    const b = h(`function g(p, q) { return p + 2 + "yy" + q.zzz; }`);
    expect(a.shapeHash).toBe(b.shapeHash);
    expect(a.exactHash).not.toBe(b.exactHash);
  });

  test("keeps operators and structure", () => {
    expect(h(`function f(a, b) { return a + b; }`).shapeHash).not.toBe(
      h(`function f(a, b) { return a * b; }`).shapeHash,
    );
    expect(h(`function f(a) { return a; }`).shapeHash).not.toBe(
      h(`function f(a) { if (a) return a; return 0; }`).shapeHash,
    );
  });
});

describe("minhash", () => {
  test("is deterministic and identical for identical shape", () => {
    const a = h(BASE);
    const b = h(BASE);
    expect(Array.from(a.minhash)).toEqual(Array.from(b.minhash));
    expect(minhashJaccard(a.minhash, b.minhash)).toBe(1);
  });

  test("tiny functions use a single shingle; empty is all 0xffffffff", () => {
    const tiny = h("x;");
    expect(tiny.minhash.every((v) => v !== 0xffffffff)).toBe(true);
    const empty = hashSymbol("", { start: 0, end: 0 }, "ts");
    expect(Array.from(empty.minhash)).toEqual(new Array(64).fill(0xffffffff));
  });

  test("minhashJaccard counts equal slots and validates length", () => {
    const a = new Uint32Array(64).fill(1);
    const b = new Uint32Array(64).fill(1);
    for (let i = 0; i < 16; i++) b[i] = 2;
    expect(minhashJaccard(a, b)).toBe(0.75);
    expect(() => minhashJaccard(a, new Uint32Array(8))).toThrow(RangeError);
  });

  test("two unrelated 10-statement functions have Jaccard < 0.4", () => {
    const one = `async function syncOrders(client, ids) {
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const res = await client.fetch(id);
    if (!res.ok) throw new Error("bad " + id);
    out.push(await res.json());
  }
  return out;
}`;
    const two = `function layout(width, rows) {
  const grid = Array.from({ length: rows }, () => []);
  let x = 0;
  let y = 0;
  while (y < rows) {
    grid[y][x] = { x, y, w: width / 2 };
    x = (x + 1) % width;
    y += x === 0 ? 1 : 0;
  }
  return grid.map((r) => r.length);
}`;
    const j = minhashJaccard(h(one).minhash, h(two).minhash);
    expect(j).toBeLessThan(0.4);
  });

  test("a small edit keeps most of the signature", () => {
    const edited = BASE.replace(
      "return sum * (1 + tax);",
      "if (!items.length) return 0;\n  return sum * (1 + tax);",
    );
    const j = minhashJaccard(h(BASE).minhash, h(edited).minhash);
    expect(j).toBeGreaterThan(0.4);
    expect(j).toBeLessThan(1);
  });
});

describe("fixtures", () => {
  test("formatRelativeDate vs parseTimestamp: same shapeHash, different exactHash", () => {
    const a = fixtureSymbol("pnpm-turbo/packages/utils/src/date.ts", "formatRelativeDate");
    const b = fixtureSymbol("pnpm-turbo/packages/utils/src/time.ts", "parseTimestamp");
    expect(a.shapeHash).toBe(b.shapeHash);
    expect(minhashJaccard(a.minhash, b.minhash)).toBeGreaterThanOrEqual(0.85);
    // Different function names (and a default-param identifier rename) must separate exact hashes.
    expect(a.exactHash).not.toBe(b.exactHash);
  });

  test("slugify exact copies share exactHash across files", () => {
    const hits = findAll("slugify");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const first = hits[0];
    for (const x of hits) {
      expect(x.exactHash).toBe(first?.exactHash);
      expect(x.shapeHash).toBe(first?.shapeHash);
    }
  });
});

function findAll(name: string) {
  const out: ReturnType<typeof fixtureSymbol>[] = [];
  const stack = ["pnpm-turbo/packages", "pnpm-turbo/apps"];
  while (stack.length) {
    const rel = stack.pop() as string;
    const abs = join(fixturesRoot, rel);
    for (const entry of readdirSync(abs)) {
      if (entry === "node_modules" || entry === ".claude") continue;
      const child = `${rel}/${entry}`;
      if (statSync(join(fixturesRoot, child)).isDirectory()) stack.push(child);
      else if (/\.tsx?$/.test(entry)) {
        const source = readFileSync(join(fixturesRoot, child), "utf8");
        if (!source.includes(`function ${name}`) && !source.includes(`const ${name}`)) continue;
        try {
          out.push(fixtureSymbol(child, name));
        } catch {
          // symbol not present in this file
        }
      }
    }
  }
  return out;
}

describe("normalizeForEmbedding", () => {
  test("renames locals and the function name to v1, v2…, replaces strings, drops comments and layout", () => {
    const src = `export function greet(name: string, polite = true) {
  // say hi
  const msg = polite ? "Good day, " : 'yo ';
  return { name, text: msg + name }; /* trailing */
}`;
    const out = normalizeForEmbedding(src, whole(src), "ts");
    expect(out).toBe(
      'function v1(v2: string, v3 = true) { const v4 = v3 ? "s" : "s"; return { name: v2, text: v4 + v2 }; }',
    );
  });

  test("same text for renamed locals and reformatting; strings and the function name do not matter", () => {
    const a = `function f(a, b) { return a + b + "x"; }`;
    const b = `function g(p,\n q) {\n // c\n return p + q + 'other'; }`;
    expect(normalizeForEmbedding(b, whole(b), "ts")).toBe(normalizeForEmbedding(a, whole(a), "ts"));
  });

  test("keeps property names, well-known globals and free identifiers", () => {
    const src = `function f(user) { return fetchUser(user.id).name; }`;
    expect(normalizeForEmbedding(src, whole(src), "ts")).toBe(
      "function v1(v2) { return fetchUser(v2.id).name; }",
    );
    const m = `const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);`;
    expect(normalizeForEmbedding(m, whole(m), "ts")).toBe(
      "const v1 = (v2, v3, v4) => Math.min(Math.max(v2, v3), v4);",
    );
  });

  test("capitalize and decapitalize no longer normalize to the same text", () => {
    const up = `function f(s) { return s.charAt(0).toUpperCase() + s.slice(1); }`;
    const low = `function f(s) { return s.charAt(0).toLowerCase() + s.slice(1); }`;
    expect(normalizeForEmbedding(up, whole(up), "ts")).not.toBe(normalizeForEmbedding(low, whole(low), "ts"));
  });

  test("template literals become the same placeholder as strings", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source code under test, not a template
    const src = "function f(n) { return `item ${n}` + 'x'; }";
    expect(normalizeForEmbedding(src, whole(src), "ts")).toBe('function v1(v2) { return "s" + "s"; }');
  });

  test("a recursive reference follows the renamed function name", () => {
    const src = `function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }`;
    expect(normalizeForEmbedding(src, whole(src), "ts")).toBe(
      "function v1(v2) { return v2 <= 1 ? 1 : v2 * v1(v2 - 1); }",
    );
  });

  test("tsx", () => {
    const src = `function C({ label }: P) { return <b title="t">{label}</b>; }`;
    expect(normalizeForEmbedding(src, whole(src), "tsx")).toBe(
      'function v1({ label: v2 }: P) { return <b title="s">{v2}</b>; }',
    );
  });

  test("does not change the hashes", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source code under test, not a template
    const src = "function f(n) { return `item ${n}`; }";
    const before = h(src);
    normalizeForEmbedding(src, whole(src), "ts");
    expect(h(src)).toEqual(before);
  });
});

describe("snapshot", () => {
  test("values are stable across runs and platforms", () => {
    const r = h(BASE);
    expect({
      exactHash: r.exactHash,
      shapeHash: r.shapeHash,
      minhash: Array.from(r.minhash),
    }).toMatchSnapshot();
  });
});

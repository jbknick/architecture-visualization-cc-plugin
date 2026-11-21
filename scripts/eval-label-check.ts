// Self-check of the endpoint, table, read and write labels against a clone (spec section 13): every file a
// label names exists, every `file:line` it gives (a handler, a function, an unresolved site) is inside the
// file and, where the label names something, the line holds that name. No network, no scoring.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Labels } from "./eval-lib.js";

/** Number of labels a case has, as printed by `check-labels`. */
export const labelCount = (l: Labels) =>
  l.route.length + l.endpoint.length + l.table.length + l.read.length + l.write.length + l.link.length;

/** The last segment of a path that is not a parameter or a wildcard, or undefined for `/`. */
export function lastLiteralSegment(path: string): string | undefined {
  const segs = path.split("/").filter((s) => s && !/^[:$]|^\{.*\}$|^\[.*\]$|^\*+$/.test(s));
  return segs.at(-1);
}

export function checkLabels(labels: Labels, cloneDir: string): string[] {
  const out: string[] = [];
  const cache = new Map<string, string[] | null>();
  const linesOf = (file: string) => {
    if (!cache.has(file)) {
      const p = join(cloneDir, file);
      cache.set(file, existsSync(p) ? readFileSync(p, "utf8").split("\n") : null);
    }
    return cache.get(file) as string[] | null;
  };
  const textOf = (file: string) => linesOf(file)?.join("\n").toLowerCase();
  /** The line at `file:line`, or a problem message. */
  const at = (file: string, line: number, what: string): { text: string } | { problem: string } => {
    const lines = linesOf(file);
    if (!lines) return { problem: `${what}: ${file} does not exist` };
    if (line > lines.length)
      return { problem: `${what}: ${file}:${line} is past the end (${lines.length} lines)` };
    return { text: lines[line - 1] as string };
  };
  const add = (r: { text: string } | { problem: string }, holds?: string, what?: string) => {
    if ("problem" in r) out.push(r.problem);
    else if (holds && !r.text.includes(holds)) out.push(`${what}: line does not hold ${holds}`);
  };

  /** The registration line is in the label's `file` and holds the method, the last literal segment of the path
   * and, when the label has a handler, the name of the function that handler line declares. */
  const checkRegistration = (
    e: { method: string; path: string; file: string; handler?: string; registration?: string },
    what: string,
  ) => {
    const w = `${what} registration`;
    const reg = e.registration as string;
    const cut = reg.lastIndexOf(":");
    const file = reg.slice(0, cut);
    if (file !== e.file) return void out.push(`${w}: ${reg} is not in ${e.file}`);
    const r = at(file, Number(reg.slice(cut + 1)), w);
    if ("problem" in r) return void out.push(r.problem);
    const text = r.text.toLowerCase();
    if (e.method !== "ALL" && !text.includes(e.method.toLowerCase()))
      out.push(`${w}: line does not hold ${e.method}`);
    const seg = lastLiteralSegment(e.path);
    if (seg && !text.includes(seg.toLowerCase())) out.push(`${w}: line does not hold ${seg}`);
    if (e.handler) {
      const hc = e.handler.lastIndexOf(":");
      const h = at(e.handler.slice(0, hc), Number(e.handler.slice(hc + 1)), `${what} handler`);
      const name = "text" in h ? /func\s+(?:\([^)]*\)\s*)?(\w+)/.exec(h.text)?.[1] : undefined;
      if (name && !r.text.includes(name)) out.push(`${w}: line does not hold ${name}`);
    }
  };

  for (const e of labels.endpoint) {
    const what = `endpoint ${"method" in e ? `${e.method} ${e.path}` : "rpc" in e ? `rpc ${e.rpc}` : `fn ${e.fn}`}`;
    if (!linesOf(e.file)) out.push(`${what}: ${e.file} does not exist`);
    else if ("path" in e) {
      const seg = lastLiteralSegment(e.path);
      if (seg && !textOf(e.file)?.includes(seg.toLowerCase()))
        out.push(`${what}: ${e.file} does not hold ${seg}`);
      if (e.handler) {
        const cut = e.handler.lastIndexOf(":");
        const w = `${what} handler`;
        add(at(e.handler.slice(0, cut), Number(e.handler.slice(cut + 1)), w), "func ", w);
      }
      if (e.registration) checkRegistration(e, what);
    }
  }
  for (const kind of ["read", "write"] as const)
    for (const p of labels[kind]) {
      const what = `${kind} ${p.file} ${p.table}`;
      if (!linesOf(p.file)) out.push(`${what}: ${p.file} does not exist`);
      else if (!textOf(p.file)?.includes(p.table.toLowerCase()))
        out.push(`${what}: ${p.file} does not hold ${p.table}`);
      for (const f of p.fns ?? [])
        add(at(p.file, f.line, `${what} fn ${f.name}`), f.name, `${what} fn ${f.name}`);
    }
  for (const r of labels.route) if (!linesOf(r.file)) out.push(`route ${r.path}: ${r.file} does not exist`);
  for (const l of labels.link) if (!linesOf(l.file)) out.push(`link ${l.endpoint}: ${l.file} does not exist`);
  for (const u of labels.unresolved) add(at(u.file, u.line, `unresolved ${u.file}:${u.line}`));
  return out;
}

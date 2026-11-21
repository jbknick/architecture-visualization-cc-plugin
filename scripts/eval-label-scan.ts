// Candidate-site scan and sample of hand labels for the TypeScript framework cases (#268, spec section 13).
// Re-runs, by stack, the greps a labeller used to find registration sites, and reports every hit that no label
// covers and the README does not list. No network, no scoring.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { lastLiteralSegment } from "./eval-label-check.js";
import { type EndpointLabel, endpointKey, type Labels, type Repo } from "./eval-lib.js";

export interface Candidate {
  file: string;
  line: number;
  /** `call` is a registration call, `file` a file that is a route by its place, `rpc` and `fn` carry a name. */
  kind: "call" | "file" | "rpc" | "fn";
  name?: string;
  text: string;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".output",
  "__tests__",
  "__mocks__",
  "test",
  "tests",
  "e2e",
  "fixtures",
  "migrations",
]);
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP_FILE = /\.(?:test|spec|stories|d)\.[cm]?[jt]sx?$|\.gen\.ts$/;

/** Source files of a clone as repo-relative posix paths, without tests, build output and vendored code. */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(p);
      } else if (CODE.test(name) && !SKIP_FILE.test(name)) out.push(relative(dir, p).split("\\").join("/"));
    }
  };
  walk(dir);
  return out;
}

const VERB_CALL = /\.(get|post|put|patch|delete|all|options|head|route|on|doc)\(/;
const NEST = /^\s*@(Get|Post|Put|Patch|Delete|All|Options|Head)\(/;
const RR =
  /<Route\b|\b(?:route|index|layout|prefix)\(\s*["'`[]|create(?:Browser|Hash|Memory)Router\(|^\s*path:\s*["'`]/;
const NEXT_FILE =
  /(?:^|\/)app\/(?:.*\/)?(?:page|route)\.[jt]sx?$|(?:^|\/)pages\/(?!_app\.|_document\.).*\.[jt]sx?$/;
const TANSTACK_ROUTE = /\bcreateFileRoute\(/;
const SERVER_FN = /\bconst\s+(\w+)\s*=\s*createServerFn\(/;
const PROCEDURE = /^\s*(\w+):\s*\w*[Pp]rocedure\b/;

/** Every candidate registration site of a repo, found by the stack's patterns (the labeller's `rg` lines). */
export function candidates(dir: string, stack: string[]): Candidate[] {
  const has = (...s: string[]) => s.some((x) => stack.includes(x));
  const out: Candidate[] = [];
  for (const file of sourceFiles(dir)) {
    if (has("nextjs") && NEXT_FILE.test(file)) out.push({ file, line: 1, kind: "file", text: file });
    const lines = readFileSync(join(dir, file), "utf8").split("\n");
    lines.forEach((text, i) => {
      const line = i + 1;
      const add = (c: Omit<Candidate, "file" | "line" | "text">) =>
        out.push({ file, line, text: text.trim(), ...c });
      if (has("express", "fastify", "hono") && (VERB_CALL.test(text) || /\bcreateRoute\(/.test(text)))
        add({ kind: "call" });
      if (has("nestjs") && NEST.test(text)) add({ kind: "call" });
      if (has("react-router") && RR.test(text)) add({ kind: "call" });
      if (has("tanstack-start", "tanstack-router") && TANSTACK_ROUTE.test(text)) add({ kind: "file" });
      const fn = has("tanstack-start") ? SERVER_FN.exec(text) : null;
      if (fn) add({ kind: "fn", name: fn[1] as string });
      const rpc = has("orpc") ? PROCEDURE.exec(text) : null;
      if (rpc) add({ kind: "rpc", name: rpc[1] as string });
    });
  }
  return out;
}

const refLine = (ref: string) => Number(ref.slice(ref.lastIndexOf(":") + 1));
const refFile = (ref: string) => ref.slice(0, ref.lastIndexOf(":"));

/** Whether a label accounts for a candidate. A call is covered by an endpoint registration on its line, or on one of
 * the next two when the call is still open there (`router.get(\n "/x",`), or by an endpoint label of that file
 * without a registration; a file by a route or endpoint label naming it; an rpc or fn by its name. */
export function covers(labels: Labels, c: Candidate): boolean {
  const eps = labels.endpoint;
  if (c.kind === "rpc")
    return eps.some(
      (e) => "rpc" in e && e.file === c.file && (e.rpc === c.name || e.rpc.endsWith(`.${c.name}`)),
    );
  if (c.kind === "fn") return eps.some((e) => "fn" in e && e.file === c.file && e.fn === c.name);
  if (c.kind === "file")
    return labels.route.some((r) => r.file === c.file) || eps.some((e) => e.file === c.file);
  // A route call (`<Route path="/x">`, `index(...)`, `path: "x"`) is covered by a route label of its file that its
  // text names: the last literal segment of the path, or an `index(` call for `/`.
  const text = c.text.toLowerCase();
  if (
    labels.route.some((r) => {
      if (r.file !== c.file) return false;
      const seg = lastLiteralSegment(r.path);
      if (seg)
        return [`/${seg}`, `'${seg}'`, `"${seg}"`, `\`${seg}`].some((s) => text.includes(s.toLowerCase()));
      return (
        /\bindex\(|path=["'{]\/["'}]|path:\s*["']\/?["']/.test(text) ||
        text.includes(`'${r.path}'`) ||
        text.includes(`"${r.path}"`)
      );
    })
  )
    return true;
  const opens = (c.text.match(/\(/g)?.length ?? 0) > (c.text.match(/\)/g)?.length ?? 0);
  return eps.some((e) => {
    if (!("method" in e) || e.file !== c.file) return false;
    if (!e.registration) return true;
    const at = refLine(e.registration);
    return (
      refFile(e.registration) === c.file && (at === c.line || (opens && at > c.line && at <= c.line + 2))
    );
  });
}

/** Sites the README lists as not labelled: lines of the form "- `<case>` `<file>:<line>`: <reason>". */
export function listedSites(readme: string, name: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of readme.split("\n")) {
    const m = /^- `([^`]+)` `([^`]+:\d+)`: (\S.*)$/.exec(l);
    if (m && m[1] === name) out.set(m[2] as string, m[3] as string);
  }
  return out;
}

/** Candidates no label covers and the README does not list. */
export function unlabelled(dir: string, repo: Repo, labels: Labels, readme: string): Candidate[] {
  const listed = listedSites(readme, repo.name);
  return candidates(dir, repo.stack).filter(
    (c) =>
      !covers(labels, c) &&
      !listed.has(`${c.file}:${c.line}`) &&
      !(c.kind === "file" && listed.has(`${c.file}:1`)),
  );
}

/** Every site the README lists for a case that is not a candidate of the scan (a stale entry). */
export function staleListed(dir: string, repo: Repo, readme: string): string[] {
  const seen = new Set(candidates(dir, repo.stack).map((c) => `${c.file}:${c.line}`));
  return [...listedSites(readme, repo.name).keys()].filter(
    (k) => !seen.has(k) && !seen.has(`${refFile(k)}:1`),
  );
}

export interface SampleLine {
  id: string;
  file: string;
  line: number;
  text: string;
}

/** Id of a label: its kind and its scoring key. */
function ids(labels: Labels): { id: string; file: string; hint?: string; registration?: string }[] {
  const out: { id: string; file: string; hint?: string; registration?: string }[] = [];
  for (const r of labels.route)
    out.push({ id: `route ${r.path}`, file: r.file, hint: lastLiteralSegment(r.path) });
  for (const e of labels.endpoint as EndpointLabel[])
    out.push({
      id: `endpoint ${"method" in e ? `${e.method.toUpperCase()} ${e.path}` : endpointKey(e)}`,
      file: e.file,
      hint: "path" in e ? lastLiteralSegment(e.path) : "rpc" in e ? e.rpc.split(".").at(-1) : e.fn,
      registration: "registration" in e ? e.registration : undefined,
    });
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Every `every`-th label (the first, the eleventh, ...) in id order, with the line of its source: the registration
 * when it has one, otherwise the first line of its file that holds the label's name, or the first line. */
export function sample(labels: Labels, dir: string, every = 10): SampleLine[] {
  const out: SampleLine[] = [];
  ids(labels).forEach((l, i) => {
    if (i % every) return;
    const p = join(dir, l.file);
    const lines = existsSync(p) ? readFileSync(p, "utf8").split("\n") : [];
    let line = l.registration ? refLine(l.registration) : 0;
    if (!line) {
      const hint = l.hint?.toLowerCase();
      const body = (t: string) => !/^\s*(?:import\b|\/\/|\*)/.test(t);
      const site =
        /createFileRoute\(|<Route\b|\b(?:path|index|route)\b\s*[:=(]|export default|^\s*\w+:\s*\w*[Pp]rocedure|createServerFn\(/;
      const find = (ok: (t: string) => boolean) => lines.findIndex((t) => body(t) && ok(t)) + 1;
      const has = (t: string) => (hint ? t.toLowerCase().includes(hint) : false);
      line = find((t) => site.test(t) && has(t)) || find(has) || find((t) => site.test(t)) || 1;
    }
    out.push({ id: l.id, file: l.file, line, text: (lines[line - 1] ?? "").trim().slice(0, 160) });
  });
  return out;
}

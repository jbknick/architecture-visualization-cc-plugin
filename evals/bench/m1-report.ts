/**
 * Pure helpers for the M1 benchmark: parsing CLI output, medians, the done-when thresholds and the results
 * table. No I/O here so the logic is unit-testable. Only aggregate numbers ever pass through this module.
 */

export const MAX_INIT_MS = 120_000;
export const MAX_UNRESOLVED_PCT = 5;

export interface InitRun {
  wallMs: number;
  /** The `ms` the indexer reports in its own summary line. */
  indexMs: number;
  files: number;
  symbols: number;
  functionLike: number;
  edges: number;
  unresolved: number;
  parseErrors: number;
}

export interface SpecifierCounts {
  file: number;
  unresolved: number;
  generated: number;
  excluded: number;
}

export interface BenchResults {
  runs: number;
  init: InitRun[];
  specifiers: SpecifierCounts;
  shaA: string;
  shaB: string;
  /** Wall ms of `gantry search` right after one file was edited (heal check + working refresh + query). */
  refreshMs: number;
  /** Wall ms of `gantry search` with a clean tree, for comparison. */
  noopSearchMs: number;
  /** The search found the symbol added by the edit, so the working layer saw it. */
  editVisible: boolean;
  /** After `git stash` and a refresh the graph dump has the clean dump's sha256. */
  stashHealed: boolean;
  /** null = not run. */
  fullSuite: boolean | null;
  healMatrix: boolean | null;
  calcom?: { files: number; wallMs: number; packagesResolved: boolean };
}

export interface DoneWhen {
  id: string;
  label: string;
  /** null = not evaluated (for example tests skipped). */
  met: boolean | null;
  detail: string;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Parses the `Indexed N files in M ms` summary that `gantry init` and `gantry index` print. */
export function parseSummary(text: string): Omit<InitRun, "wallMs"> {
  const num = (re: RegExp): number => {
    const m = re.exec(text);
    if (!m) throw new Error(`summary line not found: ${re}`);
    return Number(m[1]);
  };
  const head = /Indexed (\d+) files in (\d+) ms/.exec(text);
  if (!head) throw new Error("summary line not found: Indexed N files");
  return {
    files: Number(head[1]),
    indexMs: Number(head[2]),
    symbols: num(/symbols:\s+(\d+)/),
    functionLike: num(/function-like:\s+(\d+)/),
    edges: num(/edges:\s+(\d+)/),
    unresolved: num(/unresolved:\s+(\d+)/),
    parseErrors: num(/parse errors:\s+(\d+)/),
  };
}

/** Share of repo-internal import specifiers that did not resolve (generated/excluded are reported apart). */
export function unresolvedPct(s: SpecifierCounts): number {
  const total = s.file + s.unresolved;
  return total === 0 ? 0 : (s.unresolved / total) * 100;
}

export function evaluate(r: BenchResults): DoneWhen[] {
  const wall = median(r.init.map((i) => i.wallMs));
  const pct = unresolvedPct(r.specifiers);
  let gitflow: boolean | null;
  if (!r.editVisible || !r.stashHealed || r.healMatrix === false) gitflow = false;
  else gitflow = r.healMatrix === null ? null : true;
  return [
    {
      id: "perf",
      label: `Full index of the test bed in under ${MAX_INIT_MS / 1000} s`,
      met: wall < MAX_INIT_MS,
      detail: `${fmtMs(wall)} median wall time`,
    },
    {
      id: "resolve",
      label: `Unresolved repo-internal imports under ${MAX_UNRESOLVED_PCT}%`,
      met: pct < MAX_UNRESOLVED_PCT,
      detail: `${pct.toFixed(2)}%`,
    },
    {
      id: "determinism",
      label: "Two cold index dumps have the same sha256",
      met: r.shaA === r.shaB && r.shaA.length === 64,
      detail: r.shaA === r.shaB ? "identical" : "different",
    },
    {
      id: "gitflow",
      label: "Edit visible after one search; stash heals back to the clean dump; heal matrix passes",
      met: gitflow,
      detail: [
        `edit visible: ${yn(r.editVisible)}`,
        `stash restores clean dump: ${yn(r.stashHealed)}`,
        `heal matrix: ${triState(r.healMatrix)}`,
      ].join(", "),
    },
    {
      id: "tests",
      label: "Full vitest suite green",
      met: r.fullSuite,
      detail: triState(r.fullSuite),
    },
  ];
}

/** Exit code for the script: 1 if any done-when line is explicitly missed, else 0. */
export function exitCode(lines: DoneWhen[]): number {
  return lines.some((l) => l.met === false) ? 1 : 0;
}

function yn(b: boolean): string {
  return b ? "yes" : "no";
}

function triState(b: boolean | null): string {
  return b === null ? "not run" : b ? "pass" : "fail";
}

export function fmtMs(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i] as number)).join(" | ")} |`;
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export function resultsRows(r: BenchResults): string[][] {
  const first = r.init[0] as InitRun;
  const wall = r.init.map((i) => i.wallMs);
  const idx = r.init.map((i) => i.indexMs);
  const internal = r.specifiers.file + r.specifiers.unresolved;
  const rows: string[][] = [
    ["Files indexed", String(first.files)],
    ["Symbols", String(first.symbols)],
    ["Function-like symbols", String(first.functionLike)],
    ["Edges", String(first.edges)],
    ["Parse errors", String(first.parseErrors)],
    [
      "Unresolved repo-internal imports",
      `${r.specifiers.unresolved} of ${internal} (${unresolvedPct(r.specifiers).toFixed(2)}%)`,
    ],
    ["Generated or excluded (reported apart)", String(r.specifiers.generated + r.specifiers.excluded)],
    [`init wall time, median of ${r.runs} cold runs`, fmtMs(median(wall))],
    ["init wall time, all runs", wall.map(fmtMs).join(" / ")],
    ["Indexer-reported time, median", fmtMs(median(idx))],
    ["Determinism (sha256 of two cold dumps)", r.shaA === r.shaB ? "identical" : "DIFFERENT"],
    ["search after one edit (heal check + refresh + query)", fmtMs(r.refreshMs)],
    ["search on a clean tree", fmtMs(r.noopSearchMs)],
    ["Edit visible to search", yn(r.editVisible)],
    ["After stash, dump equals clean dump", yn(r.stashHealed)],
    ["Heal matrix", triState(r.healMatrix)],
    ["Full vitest suite", triState(r.fullSuite)],
  ];
  if (r.calcom) {
    const note = r.calcom.packagesResolved ? "" : " (packages unresolved: no install)";
    rows.push([
      "Cal.com shallow clone, init wall time",
      `${fmtMs(r.calcom.wallMs)} for ${r.calcom.files} files${note}`,
    ]);
  }
  return rows;
}

export function formatReport(r: BenchResults): string {
  const lines = evaluate(r);
  const out = [renderTable(["Metric", "Value"], resultsRows(r)), "", "Done-when:"];
  for (const l of lines) {
    const mark = l.met === null ? "NOT RUN" : l.met ? "MET" : "MISSED";
    out.push(`  [${mark}] ${l.label} (${l.detail})`);
  }
  return out.join("\n");
}

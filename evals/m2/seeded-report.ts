import { pct, table } from "./lib.js";

export interface FormResult {
  found: boolean;
  rank: number | null;
  tier: string | null;
  score: number | null;
  situation: number | null;
}
export interface SeededResult {
  id: string;
  misleading: boolean;
  hook: { found: boolean; tier: string | null; score: number | null };
  code: FormResult;
  query: FormResult;
  situation: number | null;
  expectedSituation: number;
  found: boolean;
  adviceCorrect: boolean;
  tierOk: boolean;
  foundBy: string[];
  draftCodeCosine: number | null;
  queryDescCosine: number | null;
  /** Rank of the existing function by description cosine over the whole index (1 = best), for the semantic fit. */
  queryDescRank: number | null;
  /** The best cosine of this query against any description other than the existing one. */
  queryBestOtherCosine: number | null;
}

export function printSeeded(rs: SeededResult[]): void {
  const mis = rs.filter((r) => r.misleading);
  const ok = rs.filter((r) => r.adviceCorrect);
  process.stdout.write(
    `${table(
      ["case", "misleading", "found by", "tier (hook/code/query)", "advice situation (got/want)", "correct"],
      rs.map((r) => [
        r.id,
        r.misleading ? "yes" : "no",
        r.foundBy.join("+") || "-",
        [r.hook.tier ?? "-", r.code.tier ?? "-", r.query.tier ?? "-"].join("/"),
        `${r.situation ?? "-"}/${r.expectedSituation}`,
        r.adviceCorrect ? "yes" : "no",
      ]),
    )}\n\nfound with correct advice: ${ok.length}/${rs.length} (${pct(ok.length, rs.length)}); misleading-name: ${mis.filter((r) => r.adviceCorrect).length}/${mis.length}\n`,
  );
}

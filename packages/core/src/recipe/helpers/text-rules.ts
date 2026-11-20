import picomatch from "picomatch";
import type { RegexRunner } from "./bounded-regex.js";

/**
 * Helper `text-rules`: line and regex rules over files that have no syntax tree in the index (a schema file, SQL
 * migrations). A rule names `files` globs and a `regex` (with `flags`, default `gm`); each match emits what the
 * rule's `emit` says, with `$1`, `$2` ... standing for the regex groups. The helper holds no format knowledge: the
 * regex of a schema format lives in the recipe.
 */

export interface TextRuleLike {
  files: readonly string[];
  rule: { regex: string; flags?: string | undefined };
}

export interface TextMatch {
  /** Group 0 is the whole match, group n is `$n`. Unmatched groups are empty strings. */
  groups: string[];
  /** 1-based line of the start of the match. */
  line: number;
}

export const textRuleMatches = (rule: TextRuleLike, path: string): boolean =>
  picomatch.isMatch(path, [...rule.files], { dot: true });

export type TextRun =
  | { ok: true; matches: TextMatch[] }
  | { ok: false; reason: "timeout" | "invalid" | "unavailable"; error?: string };

/**
 * Every match of a rule in a file's text. The regex is the recipe's, so it runs in the runner's worker under a time
 * budget (`bounded-regex.ts`), never on the calling thread. Flags default to `gm`.
 */
export function matchText(runner: RegexRunner, rule: TextRuleLike, text: string): TextRun {
  const r = runner.run(rule.rule.regex, rule.rule.flags ?? "gm", text);
  if (!r.ok) return r;
  return {
    ok: true,
    matches: r.matches.map((m) => {
      let line = 1;
      for (let i = 0; i < m.index; i++) if (text.charCodeAt(i) === 10) line++;
      return { groups: m.groups, line };
    }),
  };
}

/** The reason a run did not finish, as the text of `gantry recipe check` and of the skip note. */
export const runFailure = (r: Extract<TextRun, { ok: false }>, runner: RegexRunner): string =>
  r.reason === "invalid" ? `invalid regex: ${r.error ?? ""}` : `regex exceeded ${runner.jobBudgetMs} ms`;

/** Checks a rule's examples: each `match` snippet gives at least one match, each `noMatch` snippet none. */
export function runTextExamples(
  runner: RegexRunner,
  rule: TextRuleLike & { examples: { match: string[]; noMatch: string[] } },
): { passed: number; failed: string[]; error?: string } {
  const res: { passed: number; failed: string[]; error?: string } = { passed: 0, failed: [] };
  const check = (s: string, want: boolean, label: string): boolean => {
    const r = matchText(runner, rule, s);
    if (!r.ok) {
      res.error ??= runFailure(r, runner);
      return false;
    }
    if (r.matches.length > 0 === want) res.passed++;
    else
      res.failed.push(
        want ? `match: no match in ${JSON.stringify(s)}` : `${label}: matched ${JSON.stringify(s)}`,
      );
    return true;
  };
  for (const s of rule.examples.match) if (!check(s, true, "match")) return res;
  for (const s of rule.examples.noMatch) if (!check(s, false, "noMatch")) return res;
  return res;
}

/** A group reference (`$1`) or a literal (`=name`, or text as written) read against a match. */
export function groupValue(ref: string, m: TextMatch): string {
  if (/^\$\d+$/.test(ref)) return m.groups[Number(ref.slice(1))] ?? "";
  return ref.startsWith("=") ? ref.slice(1) : ref;
}

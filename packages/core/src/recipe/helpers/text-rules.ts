import picomatch from "picomatch";

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

/** Compiles the regex of a rule; null when it is not a valid regular expression. */
export function compileTextRule(rule: TextRuleLike): RegExp | null {
  const flags = rule.rule.flags ?? "gm";
  try {
    return new RegExp(rule.rule.regex, flags.includes("g") ? flags : `${flags}g`);
  } catch {
    return null;
  }
}

/** Every match of a rule in a file's text. */
export function matchText(rx: RegExp, text: string): TextMatch[] {
  const out: TextMatch[] = [];
  for (const m of text.matchAll(rx)) {
    let line = 1;
    const end = m.index ?? 0;
    for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++;
    out.push({ groups: [...m].map((g) => g ?? ""), line });
  }
  return out;
}

/** Checks a rule's examples: each `match` snippet gives at least one match, each `noMatch` snippet none. */
export function runTextExamples(rule: TextRuleLike & { examples: { match: string[]; noMatch: string[] } }): {
  passed: number;
  failed: string[];
  error?: string;
} {
  const res: { passed: number; failed: string[]; error?: string } = { passed: 0, failed: [] };
  const rx = compileTextRule(rule);
  if (!rx) return { ...res, error: "the regex does not compile" };
  for (const s of rule.examples.match) {
    if (matchText(rx, s).length > 0) res.passed++;
    else res.failed.push(`match: no match in ${JSON.stringify(s)}`);
  }
  for (const s of rule.examples.noMatch) {
    if (matchText(rx, s).length === 0) res.passed++;
    else res.failed.push(`noMatch: matched ${JSON.stringify(s)}`);
  }
  return res;
}

/** A group reference (`$1`) or a literal (`=name`, or text as written) read against a match. */
export function groupValue(ref: string, m: TextMatch): string {
  if (/^\$\d+$/.test(ref)) return m.groups[Number(ref.slice(1))] ?? "";
  return ref.startsWith("=") ? ref.slice(1) : ref;
}

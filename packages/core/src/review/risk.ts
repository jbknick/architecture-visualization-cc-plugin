/** The facts the risk score is computed from (spec section 11, "Impact and risk"). */
export interface RiskFacts {
  /** A modified symbol that is exported (before or after) has a changed signature. */
  signatureChangedExported: boolean;
  /** A removed exported symbol still has callers or importers in the graph. */
  removedExportedWithCallers: boolean;
  /** Distinct hop-1 callers. */
  hop1Callers: number;
  /** Crossings found at hop 1. */
  crossings: number;
  /** Highest cyclomatic complexity among changed (not added) functions. */
  maxComplexity: number;
  /** A changed function lives in a file that no test file (`*.test.*`, `*.spec.*`) imports. */
  untested: boolean;
}

export interface RiskRule {
  id: keyof RiskFacts;
  label: string;
  /** Points added when the rule fires (per unit when `perUnit`). */
  points: number;
  /** Counted rules multiply `points` by the count and stop at `max`. */
  perUnit?: boolean;
  max?: number;
}

/** The scoring table. One constant so a view can show it next to the score. */
export const RISK_RULES: readonly RiskRule[] = [
  { id: "signatureChangedExported", label: "signature changed on an exported symbol", points: 30 },
  { id: "removedExportedWithCallers", label: "removed exported symbol that still has callers", points: 30 },
  { id: "hop1Callers", label: "direct callers", points: 2, perUnit: true, max: 20 },
  { id: "crossings", label: "boundary crossings", points: 5, perUnit: true, max: 20 },
  { id: "maxComplexity", label: "changed function with complexity above 15", points: 10 },
  { id: "untested", label: "changed function in a file no test imports", points: 10 },
];

export const COMPLEXITY_THRESHOLD = 15;
export const RISK_CAP = 100;
/** Level boundaries: below `medium` is low, below `high` is medium, the rest is high. */
export const RISK_LEVELS = { medium: 30, high: 60 } as const;

export interface Risk {
  score: number;
  level: "low" | "medium" | "high";
  reasons: string[];
}

export function riskLevel(score: number): Risk["level"] {
  return score < RISK_LEVELS.medium ? "low" : score < RISK_LEVELS.high ? "medium" : "high";
}

/** Sum of the rules that fire, capped at 100. `reasons` has one line per firing rule with its points, in table order. */
export function computeRisk(f: RiskFacts): Risk {
  const reasons: string[] = [];
  let sum = 0;
  for (const rule of RISK_RULES) {
    const v = f[rule.id];
    let pts = 0;
    let detail = "";
    if (rule.perUnit) {
      const n = v as number;
      if (n <= 0) continue;
      pts = Math.min(n * rule.points, rule.max ?? Number.POSITIVE_INFINITY);
      detail = `${n} ${rule.label}`;
    } else {
      const fires = rule.id === "maxComplexity" ? (v as number) > COMPLEXITY_THRESHOLD : v === true;
      if (!fires) continue;
      pts = rule.points;
      detail = rule.id === "maxComplexity" ? `${rule.label} (${v})` : rule.label;
    }
    sum += pts;
    reasons.push(`+${pts} ${detail}`);
  }
  const score = Math.min(sum, RISK_CAP);
  return { score, level: riskLevel(score), reasons };
}

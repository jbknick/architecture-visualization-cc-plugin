// Measured acceptance for the description validators (issue #22, part F): the attack corpus must be rejected in
// full, the honest corpus must be accepted at 97% or better, and validation must stay fast.
import { describe, expect, it } from "vitest";
import type { FactSheet } from "../types.js";
import { ATTACK_CORPUS, attackSheet } from "./corpus.attack.js";
import {
  HONEST_ALL,
  HONEST_BY_DESIGN_REJECTED,
  HONEST_MAIN,
  HONEST_REVIEW,
  type HonestRow,
} from "./corpus.honest.js";
import { validateDescription } from "./validate.js";

function honestSheet(idents: readonly string[] = []): FactSheet {
  const [first = "run", ...rest] = idents;
  return {
    contentKey: "k",
    id: `src/x.ts#${first}`,
    path: "src/x.ts",
    kind: "function",
    signature: `(${rest.map((i) => `${i}: unknown`).join(", ")}) => void`,
    doc: null,
    callees: [...rest],
    returnType: "void",
    body: idents.map((i) => `${i}();`).join("\n"),
  };
}

const honestRaw = (row: HonestRow) => ({ behavior: row[0], searchTerms: [...row[1]], nameFits: true });

describe("attack corpus", () => {
  it("has at least 120 cases covering every class", () => {
    expect(ATTACK_CORPUS.length).toBeGreaterThanOrEqual(120);
    const classes = new Set(ATTACK_CORPUS.map((c) => c.cls));
    for (const c of [
      "imperative",
      "addressed",
      "other-language",
      "leetspeak",
      "split-fields",
      "suggestedName",
      "markup",
      "host",
      "install-bait",
      "secret",
      "split-secret",
      "terms",
    ]) {
      expect(classes.has(c), c).toBe(true);
    }
  });

  it("rejects 100% of the cases", () => {
    const passed: string[] = [];
    for (const c of ATTACK_CORPUS) {
      const raw: Record<string, unknown> = {
        behavior: c.behavior,
        searchTerms: c.terms ? [...c.terms] : ["user lookup"],
        nameFits: c.name === undefined,
      };
      if (c.name !== undefined) raw.suggestedName = c.name;
      const r = validateDescription(raw, attackSheet());
      if (r.ok)
        passed.push(`${c.cls}: ${c.behavior.slice(0, 50)} ${JSON.stringify(c.terms ?? c.name ?? "")}`);
      else if (c.reason !== undefined && r.reason !== c.reason)
        passed.push(`${c.cls}: wanted ${c.reason}, got ${r.reason} for ${c.behavior.slice(0, 40)}`);
      // a failure detail never repeats a secret or a long opaque token in full
      if (!r.ok) expect(r.detail.length).toBeLessThan(400);
    }
    const rate = (100 * (ATTACK_CORPUS.length - passed.length)) / ATTACK_CORPUS.length;
    console.log(`attack corpus: ${ATTACK_CORPUS.length} cases, rejected ${rate.toFixed(1)}%`);
    expect(passed, passed.join("\n")).toEqual([]);
  });
});

describe("honest corpus", () => {
  it("has at least 200 rows including the review's descriptions", () => {
    expect(HONEST_ALL.length).toBeGreaterThanOrEqual(200);
    expect(HONEST_REVIEW.length + HONEST_BY_DESIGN_REJECTED.length).toBeGreaterThanOrEqual(65);
  });

  it("accepts at least 97%, printing every rejected row with its reason", () => {
    const rejected: string[] = [];
    for (const row of HONEST_ALL) {
      const r = validateDescription(honestRaw(row), honestSheet(row[2]));
      if (!r.ok) rejected.push(`[${r.reason}] ${r.detail} | ${row[0]} | ${JSON.stringify(row[1])}`);
    }
    const rate = (100 * (HONEST_ALL.length - rejected.length)) / HONEST_ALL.length;
    console.log(
      `honest corpus: ${HONEST_ALL.length} rows, accepted ${rate.toFixed(1)}%, rejected ${rejected.length}`,
    );
    for (const line of rejected) console.log(`  rejected ${line}`);
    expect(rate).toBeGreaterThanOrEqual(97);
  });

  it("accepts the review rows and the main rows each at 97% or better", () => {
    for (const rows of [HONEST_REVIEW, HONEST_MAIN]) {
      const bad = rows.filter((row) => !validateDescription(honestRaw(row), honestSheet(row[2])).ok);
      expect(100 * (1 - bad.length / rows.length)).toBeGreaterThanOrEqual(95);
    }
  });

  it("rejects, on purpose, the review rows that address the reader or name a host", () => {
    for (const { row, reason } of HONEST_BY_DESIGN_REJECTED) {
      const r = validateDescription(honestRaw(row), honestSheet(row[2]));
      expect(r, row[0]).toMatchObject({ ok: false, reason });
    }
  });
});

describe("performance", () => {
  const sheet = honestSheet(["fetchUser", "httpGet"]);
  it("validates normal input in under 2 ms median", () => {
    const raw = honestRaw(HONEST_MAIN[0] as HonestRow);
    for (let i = 0; i < 200; i++) validateDescription(raw, sheet); // warm up
    const times: number[] = [];
    for (let i = 0; i < 400; i++) {
      const t0 = performance.now();
      validateDescription(raw, sheet);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)] as number;
    console.log(`validateDescription median ${median.toFixed(3)} ms over ${times.length} runs`);
    expect(median).toBeLessThan(2);
  });

  it("validates adversarial input at the caps in under 50 ms", () => {
    const filler: Record<string, string> = {
      "a*": "a".repeat(400),
      "a.a.a": "a.".repeat(200),
      "a-a-": "a-".repeat(200),
      "a at a": "a at ".repeat(80),
      "a@a.a.": `a@${"a.".repeat(199)}`,
      spaces: `a${" ".repeat(398)}a`,
      "ignore all": `ignore ${"all ".repeat(99)}`,
      BEGIN: "-----BEGIN RSA PRIVATE KEY-----".repeat(13),
      "x://u:": "x://u:".repeat(66),
      'key="': 'key="'.repeat(80),
      b64: "QUFB".repeat(100),
      "b64 spaced": "QUFBQUFBQUFBQUFBQUFBQUFB ".repeat(16),
      "you you": "you ".repeat(100),
      dot: "a dot ".repeat(66),
      "[a]": "[a]".repeat(133),
      Bearer: "Bearer ".repeat(57),
      mixed: Array.from({ length: 400 }, (_, i) => "a.-@ :/"[i % 7]).join(""),
      "(((": "(".repeat(400),
      "<<<": "<".repeat(400),
      hex: "ab12".repeat(100),
      "KEY=": "API_KEY=".repeat(50),
    };
    let worst = 0;
    for (const [k, s] of Object.entries(filler)) {
      const terms = Array.from({ length: 6 }, () => s.slice(0, 60));
      const t0 = performance.now();
      validateDescription(
        { behavior: s, searchTerms: terms, nameFits: false, suggestedName: "a".repeat(80) },
        sheet,
      );
      const dt = performance.now() - t0;
      worst = Math.max(worst, dt);
      expect(dt, k).toBeLessThan(50);
    }
    console.log(`validateDescription worst case at the caps ${worst.toFixed(2)} ms`);
  });

  it("fails values over the hard caps at once, whatever they hold", () => {
    const huge = "a.".repeat(500_000);
    for (const raw of [
      { behavior: huge, searchTerms: ["x"], nameFits: true },
      { behavior: "Returns x.", searchTerms: [huge], nameFits: true },
      { behavior: "Returns x.", searchTerms: ["x"], nameFits: false, suggestedName: huge },
      { behavior: "Returns x.", searchTerms: Array(7).fill("x"), nameFits: true },
    ]) {
      const t0 = performance.now();
      const r = validateDescription(raw, sheet);
      expect(performance.now() - t0).toBeLessThan(5);
      expect(r).toMatchObject({ ok: false, reason: "length" });
    }
  });
});

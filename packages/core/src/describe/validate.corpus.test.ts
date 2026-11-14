// Measured acceptance for the description validators (issue #22, final round): both attack corpora must be rejected in
// full, the honest corpora must be accepted at 97% or better, the held-out set at 90% or better, real model output at
// 93% or better (when the private set is present), and validation must stay fast.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactSheet } from "../types.js";
import { ATTACK_CORPUS, attackSheet } from "./corpus.attack.js";
import { ATTACK_CORPUS_2, RESIDUAL_CLAIMS } from "./corpus.attack2.js";
import { ATTACK_CORPUS_3, KNOWN_BYPASSES } from "./corpus.attack3.js";
import { HONEST_HELDOUT } from "./corpus.heldout.js";
import {
  HONEST_ALL,
  HONEST_BY_DESIGN_REJECTED,
  HONEST_MAIN,
  HONEST_REVIEW,
  type HonestRow,
} from "./corpus.honest.js";
import { fullSheet, HONEST_FINAL, HONEST_REVIEW_2, type HonestFull } from "./corpus.honest2.js";
import { sheet as sessionSheet } from "./validate.fixtures.js";
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
const fullRaw = (row: HonestFull) => {
  const raw: Record<string, unknown> = {
    behavior: row[4],
    searchTerms: [...row[5]],
    nameFits: row[6] === undefined,
  };
  if (row[6] !== undefined) raw.suggestedName = row[6];
  return raw;
};

type AnyAttack = {
  cls: string;
  behavior: string;
  terms?: readonly string[];
  name?: string;
  reason?: string;
  sheet?: FactSheet;
};

function runAttacks(corpus: readonly AnyAttack[], defaultSheet: () => FactSheet): string[] {
  const passed: string[] = [];
  for (const c of corpus) {
    const raw: Record<string, unknown> = {
      behavior: c.behavior,
      searchTerms: c.terms ? [...c.terms] : ["user lookup"],
      nameFits: c.name === undefined,
    };
    if (c.name !== undefined) raw.suggestedName = c.name;
    const r = validateDescription(raw, c.sheet ?? defaultSheet());
    if (r.ok) passed.push(`${c.cls}: ${c.behavior.slice(0, 60)} ${JSON.stringify(c.terms ?? c.name ?? "")}`);
    else if (c.reason !== undefined && r.reason !== c.reason)
      passed.push(`${c.cls}: wanted ${c.reason}, got ${r.reason} for ${c.behavior.slice(0, 40)}`);
    // a failure detail never repeats a secret or a long opaque token in full
    if (!r.ok) expect(r.detail.length).toBeLessThan(400);
  }
  return passed;
}

describe("attack corpus", () => {
  it("has at least 350 cases covering every class", () => {
    const all = [...ATTACK_CORPUS, ...ATTACK_CORPUS_2];
    expect(all.length).toBeGreaterThanOrEqual(350);
    const classes = new Set(all.map((c) => c.cls));
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
      "r2-clause",
      "r2-terms",
      "r2-strip",
      "r2-name",
      "r2-bait",
      "r2-hostile-sheet",
      "r2-chars",
      "gen-clause",
      "gen-speech",
      "gen-permission",
      "gen-subject",
      "gen-bait",
      "gen-host",
      "gen-file",
      "secret-copy",
    ]) {
      expect(classes.has(c), c).toBe(true);
    }
  });

  it("rejects 100% of the first-round cases", () => {
    const passed = runAttacks(ATTACK_CORPUS, () => attackSheet());
    const rate = (100 * (ATTACK_CORPUS.length - passed.length)) / ATTACK_CORPUS.length;
    console.log(`attack corpus 1: ${ATTACK_CORPUS.length} cases, rejected ${rate.toFixed(1)}%`);
    expect(passed, passed.join("\n")).toEqual([]);
  });

  it("rejects 100% of the second review's cases and their variants", () => {
    const passed = runAttacks(ATTACK_CORPUS_2, () => sessionSheet());
    const rate = (100 * (ATTACK_CORPUS_2.length - passed.length)) / ATTACK_CORPUS_2.length;
    console.log(`attack corpus 2: ${ATTACK_CORPUS_2.length} cases, rejected ${rate.toFixed(1)}%`);
    expect(passed, passed.join("\n")).toEqual([]);
  });

  it("rejects 100% of the third review's cases (issue #108) and their generated variants", () => {
    const passed = runAttacks(ATTACK_CORPUS_3, () => sessionSheet());
    const rate = (100 * (ATTACK_CORPUS_3.length - passed.length)) / ATTACK_CORPUS_3.length;
    console.log(`attack corpus 3: ${ATTACK_CORPUS_3.length} cases, rejected ${rate.toFixed(1)}%`);
    expect(ATTACK_CORPUS_3.length).toBeGreaterThanOrEqual(500);
    expect(passed, passed.join("\n")).toEqual([]);
  });

  it("lists the accepted residual risk next to the corpus", () => {
    expect(RESIDUAL_CLAIMS.length).toBeGreaterThan(0);
    expect(KNOWN_BYPASSES.length).toBeGreaterThan(0);
  });
});

describe("honest corpus", () => {
  const all = (): { label: string; behavior: string; ok: boolean; why: string }[] => {
    const out: { label: string; behavior: string; ok: boolean; why: string }[] = [];
    for (const row of HONEST_ALL) {
      const r = validateDescription(honestRaw(row), honestSheet(row[2]));
      out.push({ label: "main", behavior: row[0], ok: r.ok, why: r.ok ? "" : `[${r.reason}] ${r.detail}` });
    }
    for (const [label, rows] of [
      ["review2", HONEST_REVIEW_2],
      ["final", HONEST_FINAL],
    ] as const) {
      for (const row of rows) {
        const r = validateDescription(fullRaw(row), fullSheet(row));
        out.push({ label, behavior: row[4], ok: r.ok, why: r.ok ? "" : `[${r.reason}] ${r.detail}` });
      }
    }
    return out;
  };

  it("has at least 300 rows, 130 of them with full fact sheets", () => {
    expect(HONEST_ALL.length + HONEST_REVIEW_2.length + HONEST_FINAL.length).toBeGreaterThanOrEqual(300);
    expect(HONEST_REVIEW_2.length).toBeGreaterThanOrEqual(60);
    expect(HONEST_FINAL.length).toBeGreaterThanOrEqual(60);
    expect(HONEST_REVIEW.length + HONEST_BY_DESIGN_REJECTED.length).toBeGreaterThanOrEqual(65);
  });

  it("accepts at least 97%, printing every rejected row with its reason", () => {
    const rows = all();
    const rejected = rows.filter((r) => !r.ok);
    const rate = (100 * (rows.length - rejected.length)) / rows.length;
    console.log(
      `honest corpus: ${rows.length} rows, accepted ${rate.toFixed(1)}%, rejected ${rejected.length}`,
    );
    for (const r of rejected) console.log(`  rejected (${r.label}) ${r.why} | ${r.behavior}`);
    expect(rate).toBeGreaterThanOrEqual(97);
  });

  it("accepts each part (review rows, main rows, review 2, final) at 95% or better", () => {
    const rows = all();
    for (const label of ["main", "review2", "final"]) {
      const part = rows.filter((r) => r.label === label);
      expect(100 * (part.filter((r) => r.ok).length / part.length), label).toBeGreaterThanOrEqual(95);
    }
  });

  it("accepts the sentences the issue names", () => {
    const sheet = honestSheet(["formatPrice"]);
    for (const [behavior, terms] of [
      ["Formats an amount in cents as a price in US dollars.", ["price format"]],
      ["Requeues every failed job and returns how many were added back.", ["requeue jobs"]],
      ["Archives the project instead of removing the row.", ["archive project"]],
      ["Asks the user to confirm deletion.", ["confirm dialog"]],
      ["Lets the user pick which AI agent handles the ticket.", ["agent routing"]],
    ] as const) {
      const r = validateDescription({ behavior, searchTerms: [...terms], nameFits: true }, sheet);
      expect(r, behavior).toMatchObject({ ok: true });
    }
  });

  it("rejects, on purpose, the review rows that address the reader or name a host", () => {
    for (const { row, reason } of HONEST_BY_DESIGN_REJECTED) {
      const r = validateDescription(honestRaw(row), honestSheet(row[2]));
      expect(r, row[0]).toMatchObject({ ok: false, reason });
    }
  });
});

describe("held-out honest set", () => {
  it("accepts at least 90% of 60 descriptions written after the tuning was finished", () => {
    expect(HONEST_HELDOUT.length).toBeGreaterThanOrEqual(60);
    const rejected: string[] = [];
    for (const row of HONEST_HELDOUT) {
      const r = validateDescription(fullRaw(row), fullSheet(row));
      if (!r.ok) rejected.push(`[${r.reason}] ${r.detail} | ${row[4]}`);
    }
    const rate = (100 * (HONEST_HELDOUT.length - rejected.length)) / HONEST_HELDOUT.length;
    console.log(`held-out: ${HONEST_HELDOUT.length} rows, accepted ${rate.toFixed(1)}%`);
    for (const line of rejected) console.log(`  rejected ${line}`);
    expect(rate).toBeGreaterThanOrEqual(90);
  });
});

describe("real model output (private, counts only)", () => {
  const privateDir = process.env.GANTRY_PRIVATE_DIR ?? join(process.cwd(), "evals", "private");
  const present = existsSync(join(privateDir, "describe-out", "path-a"));
  it.skipIf(!present)("accepts at least 93% of the stored descriptions", async () => {
    const storePath = "../../../../docs/spikes/describe/store.js";
    const { loadLabelled, loadCalls, descriptionsFrom, outDir } = (await import(
      /* @vite-ignore */ storePath
    )) as {
      loadLabelled: () => { factSheet: { contentKey: string } }[];
      loadCalls: (dir: string, kind: string) => unknown;
      descriptionsFrom: (calls: unknown) => Map<string, unknown>;
      outDir: string;
    };
    const rows = loadLabelled();
    const descs = descriptionsFrom(loadCalls(join(outDir, "path-a"), "call"));
    let total = 0;
    let accepted = 0;
    for (const row of rows) {
      const d = descs.get(row.factSheet.contentKey);
      if (d === undefined) continue;
      total++;
      if (validateDescription(d, row.factSheet as unknown as FactSheet).ok) accepted++;
    }
    console.log(
      `real output: ${total} descriptions, accepted ${accepted} (${((100 * accepted) / total).toFixed(1)}%)`,
    );
    expect(total).toBeGreaterThanOrEqual(150);
    expect(100 * (accepted / total)).toBeGreaterThanOrEqual(93);
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
      "then delete": "then delete ".repeat(33),
      "tells agent": "tells the agent ".repeat(25),
      "to to": "to fetch and ".repeat(30),
      "; ;": "; delete the ".repeat(30),
      "1 1 1": "1 ".repeat(200),
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

  it("scans a fact sheet at the grounding caps in under 50 ms", () => {
    const big = honestSheet(["fetchUser"]);
    big.signature = `(${"a: string, ".repeat(100)})`;
    big.doc = "word ".repeat(400);
    big.body = "const x = foo.bar(baz);\n".repeat(400);
    const raw = honestRaw(HONEST_MAIN[0] as HonestRow);
    validateDescription(raw, big);
    const t0 = performance.now();
    validateDescription(raw, big);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

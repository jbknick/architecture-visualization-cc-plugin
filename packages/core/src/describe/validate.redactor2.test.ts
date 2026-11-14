// Redactor follow-ups (issue #108): unquoted environment assignments, joined-literal splits, positional credential
// arguments, and the four things it must stop redacting (i18n labels, commit SHAs, SRI hashes, routes).
// Credential-looking strings are assembled from pieces so no whole key is stored in this file.
import { describe, expect, it } from "vitest";
import { redactForFactSheet, scanSecrets } from "./secrets.js";

const STRIPE = `${"sk"}_${"live"}_${"4eC39HqLyjWDarjtT1zdp7dc"}`;

describe("redactor catches (issue #108)", () => {
  const cases: [string, string, string][] = [
    ["unquoted env assignment", `export SIGNING_MATERIAL=${"a1b2c3d4e5f6a7b8c9"}`, "a1b2c3d4e5f6a7b8c9"],
    ["env assignment on a line", `DEPLOY_HOOK=${"x9y8z7w6v5u4t3s2r1"}\nPORT=3000`, "x9y8z7w6v5u4t3s2r1"],
    [
      "array join split key",
      `const k = ["sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc"].join("");`,
      "4eC39HqLyjWDarjtT1zdp7dc",
    ],
    [
      "array join split behind a credential name",
      `const password = ['correct', 'horse', 'battery'].join('');`,
      "correct",
    ],
    ["positional login", `await client.login("admin", "hunter2pass");`, "hunter2pass"],
    ["positional setPassword", `setPassword("hunter2pass");`, "hunter2pass"],
    ["cli flag with space", "tool deploy --password hunter2pass --force", "hunter2pass"],
    ["cli flag with equals", "tool deploy --api-key=abc123def456", "abc123def456"],
    ["curl basic", "curl -u admin:hunter2pass https://example.com/x", "hunter2pass"],
  ];
  for (const [name, text, secret] of cases) {
    it(`redacts ${name}`, () => {
      const out = redactForFactSheet(text);
      expect(out, name).toContain("<redacted>");
      expect(out, name).not.toContain(secret);
      expect(scanSecrets(text).length, `${name}: the scanner agrees`).toBeGreaterThan(0);
      expect(redactForFactSheet(out), "idempotent").toBe(out);
    });
  }

  it("keeps the rest of the line when it redacts an assignment", () => {
    expect(redactForFactSheet(`export SIGNING_MATERIAL=${"a1b2c3d4e5f6a7b8c9"}`)).toBe(
      "export SIGNING_MATERIAL=<redacted>",
    );
  });

  it("joins the stripe pieces", () => {
    const joined = `const k = ["sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc"].join("");`;
    expect(joined).not.toContain(STRIPE);
    expect(scanSecrets(joined)).toContain("joined-literals");
  });
});

describe("redactor leaves alone (issue #108)", () => {
  const same: [string, string][] = [
    ["i18n label", `const messages = { password: "Enter your password", token: "Your access Token" };`],
    ["i18n key", `t("auth.password"); { passwordLabel: "Password" }`],
    ["commit sha after a word", "See commit 356a192b7913b04c54574d18c28d46e6395428ab for details."],
    ["commit sha in a url", "https://github.com/o/r/commit/356a192b7913b04c54574d18c28d46e6395428ab"],
    [
      "sha after a hash",
      "resolved: git+ssh://git@github.com/o/r.git#356a192b7913b04c54574d18c28d46e6395428ab",
    ],
    ["rev assignment", 'rev = "356a192b7913b04c54574d18c28d46e6395428ab"'],
    [
      "sri hash",
      '<script integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC">',
    ],
    ["route", 'router.get("/api/v1/organizations/:orgId/invitation-templates/:templateId", handler);'],
    ["plain env assignments", "NODE_ENV=production PORT=3000 LOG_LEVEL=debug"],
    ["login with a route", 'router.login("admin", "/dashboard");'],
    ["authenticate strategy", 'passport.authenticate("local", { session: false });'],
    ["cli flag with a variable", "tool deploy --password $DEPLOY_PASSWORD --token ${TOKEN}"],
  ];
  for (const [name, text] of same) {
    it(`does not change ${name}`, () => {
      expect(redactForFactSheet(text)).toBe(text);
    });
  }

  it("still reports a bare 40-digit hex on the description side", () => {
    expect(scanSecrets("commit 356a192b7913b04c54574d18c28d46e6395428ab")).toContain("hex-secret");
  });

  it("still redacts a hex run that is not a commit id", () => {
    const out = redactForFactSheet('const k = "356a192b7913b04c54574d18c28d46e6395428ab";');
    expect(out).toContain("<redacted>");
  });

  it("still redacts a label-shaped secret that is lower case or holds a digit", () => {
    expect(redactForFactSheet('password: "correct horse battery"')).toContain("<redacted>");
    expect(redactForFactSheet('password: "Correct horse 7 battery"')).toContain("<redacted>");
  });
});

describe("redactor patterns stay linear", () => {
  it("handles adversarial input at 100k characters in under 1.5 s", () => {
    const inputs: Record<string, string> = {
      arrays: '["a",'.repeat(20_000),
      "arrays closed": '["a", "b"] . join ( '.repeat(5_000),
      calls: "login(".repeat(15_000),
      "calls with literals": 'login("a", '.repeat(9_000),
      env: "AB_".repeat(33_000),
      "env eq": "A_B=".repeat(25_000),
      flags: "--password ".repeat(9_000),
      "flags eq": "-token=".repeat(14_000),
      curl: "-u a:".repeat(20_000),
      hex: "ab".repeat(50_000),
      "hex spaced": "ab12 ".repeat(20_000),
      route: "/ab-cd".repeat(16_000),
    };
    for (const [name, text] of Object.entries(inputs)) {
      const t0 = performance.now();
      redactForFactSheet(text);
      scanSecrets(text.slice(0, 8000));
      const dt = performance.now() - t0;
      expect(dt, name).toBeLessThan(1500);
    }
  });
});

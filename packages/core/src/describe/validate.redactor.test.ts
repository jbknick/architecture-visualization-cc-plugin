// Redactor measurements (issue #22, final round): every credential format from both reviews is caught, and the redactor
// leaves this repository's own source code alone.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { itTiming } from "./itTiming.js";
import { CREDENTIAL_FORMATS } from "./secrets.formats.js";
import { redactForFactSheet, scanSecrets } from "./secrets.js";

describe("credential formats from both reviews", () => {
  it("has at least 50 formats", () => {
    expect(Object.keys(CREDENTIAL_FORMATS).length).toBeGreaterThanOrEqual(50);
  });

  for (const [name, value] of Object.entries(CREDENTIAL_FORMATS)) {
    it(`${name}: the scanner reports it and the redactor changes it`, () => {
      expect(scanSecrets(value).length, "scanner").toBeGreaterThan(0);
      const wrapped = `const x = ${JSON.stringify(value)};\n// ${value}\n${value}\n`;
      expect(redactForFactSheet(wrapped), "redactor").not.toBe(wrapped);
      expect(redactForFactSheet(value), "redactor alone").not.toBe(value);
    });
  }

  it("redacts a Set-Cookie value and a session cookie of 16 characters or more", () => {
    expect(redactForFactSheet("Set-Cookie: sid=abcdefghijklmnop0123; Path=/")).toContain("<redacted>");
    expect(redactForFactSheet("session=ab12")).toBe("session=ab12");
  });
});

describe("redactor precision on this repository's own source", () => {
  const root = join(__dirname, "..", "..", "..", "..");
  const skip =
    /(?:\.test\.ts|\.formats\.ts|\/corpus\.[a-z0-9]+\.ts|validate\.fixtures\.ts|testkit\.ts|wordlist\.data\.ts)$/;
  const walk = (dir: string, out: string[]): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "fixtures") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e.name) && !skip.test(p)) out.push(p);
    }
    return out;
  };

  it("changes fewer than 2% of the non-test source files under packages/*/src", () => {
    const files: string[] = [];
    for (const pkg of readdirSync(join(root, "packages"))) {
      const src = join(root, "packages", pkg, "src");
      if (existsSync(src)) walk(src, files);
    }
    const changed = files.filter((f) => {
      const s = readFileSync(f, "utf8");
      return redactForFactSheet(s) !== s;
    });
    const list = changed.map((f) => f.slice(root.length + 1)).join(", ");
    console.log(
      `redactor changed ${changed.length} of ${files.length} source files${list === "" ? "" : `: ${list}`}`,
    );
    expect(files.length).toBeGreaterThan(50);
    expect(changed.length / files.length).toBeLessThan(0.02);
  });

  itTiming("redacts 100k characters in under 1.5 s", () => {
    const text = 'const apiKey = "abc123def456";\n'.repeat(3300);
    const t0 = performance.now();
    redactForFactSheet(text);
    const dt = performance.now() - t0;
    console.log(`redactForFactSheet on ${text.length} characters: ${dt.toFixed(1)} ms`);
    expect(dt).toBeLessThan(1500);
  });
});

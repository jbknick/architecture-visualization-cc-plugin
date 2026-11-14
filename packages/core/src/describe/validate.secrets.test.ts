import { describe, expect, it } from "vitest";
import { redactForFactSheet, scanSecrets, shannonEntropy } from "./secrets.js";
import { FAKE } from "./validate.fixtures.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");

const POSITIVE: [string, string, string][] = [
  ["aws access key", `const k = "${FAKE.aws}";`, "aws-access-key"],
  ["aws temp key (ASIA)", `id=${"ASIA"}${"IOSFODNN7EXAMPLE"}`, "aws-access-key"],
  [
    "aws secret key",
    `aws_secret_access_key = "${"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}"`,
    "aws-secret-key",
  ],
  ["github ghp", `token: ${FAKE.github}`, "github-token"],
  ["github fine-grained", `${"github_pat"}_${"11ABCDEFG0abcdefghijkl_mnopqrstuv"}`, "github-token"],
  ["github gho", `${"gho"}_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`, "github-token"],
  ["gitlab", `${"glpat"}-${"abcdefghij0123456789"}`, "gitlab-token"],
  ["slack bot", `SLACK=${FAKE.slack}`, "slack-token"],
  [
    "slack webhook",
    `${"https://hooks.slack"}.com/services/${"T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX"}`,
    "slack-webhook",
  ],
  ["stripe live", FAKE.stripe, "stripe-key"],
  ["stripe test restricted", `${"rk"}_${"test"}_${"4eC39HqLyjWDarjtT1zdp7dc"}`, "stripe-key"],
  ["anthropic key", `${"sk-ant"}-${"api03-abcdefghijklmnopqrstuvwxyz0123"}`, "openai-anthropic-key"],
  ["google api key", `${"AIza"}${"SyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q"}`, "google-api-key"],
  ["npm token", `${"npm"}_${"abcdefghijklmnopqrstuvwxyz0123456789"}`, "npm-token"],
  ["rsa private key", FAKE.pem, "private-key"],
  ["openssh private key header", `${"-----BEGIN OPENSSH"} ${"PRIVATE KEY-----"}`, "private-key"],
  ["pgp private key block", `${"-----BEGIN PGP"} ${"PRIVATE KEY BLOCK-----"}`, "private-key"],
  ["jwt", `Authorization: ${FAKE.jwt}`, "jwt"],
  ["postgres url", FAKE.conn, "connection-string"],
  [
    "mongodb srv url",
    `${"mongodb+srv"}://${"user"}:${"p4ssw0rd"}@cluster0.example.net/db`,
    "connection-string",
  ],
  ["redis url", `${"redis"}://${"default"}:${"s3cr3tvalue"}@cache:6379`, "connection-string"],
  ["bearer", `Bearer ${"abcdefghijklmnopqrstuvwxyz012345"}`, "bearer-token"],
  ["sha1 sized hex", "commit 356a192b7913b04c54574d18c28d46e6395428ab", "hex-secret"],
  ["apiKey assignment", `apiKey: "${"abcd1234efgh5678ijkl"}"`, "generic-credential"],
  ["secret assignment single quote", `const secret = '${"s3cr3t-value-0123456789"}'`, "generic-credential"],
  ["token assignment backtick", "const token = `" + "abcd1234efgh5678ijkl`", "generic-credential"],
  ["password assignment", `password = "${"correct horse battery"}"`, "generic-credential"],
  ["high entropy blob", `const x = "${FAKE.blob}";`, "high-entropy"],
  ["zero-width split AWS key", `${FAKE.aws.slice(0, 6)}​${FAKE.aws.slice(6)}`, "aws-access-key"],
  ["fullwidth ghp key", FAKE.github.replace("ghp", "ｇｈｐ"), "github-token"],
  ["base64-wrapped aws key", `blob = ${b64(`key=${FAKE.aws} ok`)}`, "base64:aws-access-key"],
  ["base64-wrapped github token", `${b64(FAKE.github + " end")}`, "base64:github-token"],
];

describe("scanSecrets", () => {
  for (const [name, text, rule] of POSITIVE) {
    it(`finds ${name}`, () => {
      expect(scanSecrets(text)).toContain(rule);
    });
  }

  const NEGATIVE: [string, string][] = [
    ["empty", ""],
    ["plain prose", "Removes the cached session for a user."],
    ["code", "const user = await db.find(userId);\nreturn user?.name ?? 'anonymous';"],
    ["long camelCase identifier", "const aVeryLongDescriptiveIdentifierNameForAThing = 1;"],
    ["long path", "import x from 'packages/core/src/describe/prompts/deep/nested/path/file';"],
    ["uuid", "id: '123e4567-e89b-12d3-a456-426614174000'"],
    ["short key assignment", "const key = 'id';"],
    ["tokenizer assignment of short value", "const token = 'abc';"],
    ["key type annotation", "const apiKey: string = getKey();"],
    ["url without credentials", "https://example.com/path:8080/x@y"],
    ["version strings", "version: '1.2.3-beta.4+build.567'"],
    ["Bearer prose", "Bearer authentication is supported."],
  ];
  for (const [name, text] of NEGATIVE) {
    it(`no hit: ${name}`, () => {
      expect(scanSecrets(text)).toEqual([]);
    });
  }

  it("returns rule names only, never the matched text", () => {
    for (const [, text] of POSITIVE) {
      for (const hit of scanSecrets(text)) expect(hit).toMatch(/^(?:base64:)?[a-z-]+$/);
    }
  });

  it("computes entropy", () => {
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("abcd")).toBe(2);
    expect(shannonEntropy(FAKE.blob)).toBeGreaterThanOrEqual(4);
  });
});

describe("redactForFactSheet", () => {
  it("removes every secret sample", () => {
    for (const [name, text] of POSITIVE) {
      const out = redactForFactSheet(text);
      expect(out, name).toContain("<redacted>");
      expect(scanSecrets(out), name).toEqual([]);
    }
  });

  it("leaves code without secrets exactly unchanged", () => {
    const code = [
      "export function clearCachedSession(userId: string): Promise<void> {",
      "  const user_key = makeKey(userId); // see https://example.com/docs",
      "  const retries = 3;",
      "  const id = '123e4567-e89b-12d3-a456-426614174000';",
      "  const aVeryLongDescriptiveIdentifierNameForAThing = await cache.remove(user_key);",
      "  return logAudit(`cleared " + "$" + "{userId}`);",
      "}",
    ].join("\n");
    expect(redactForFactSheet(code)).toBe(code);
  });

  it("changes only the secret in surrounding code", () => {
    const before = `const a = 1;\nconst k = "${FAKE.aws}";\nconst b = 2;`;
    expect(redactForFactSheet(before)).toBe('const a = 1;\nconst k = "<redacted>";\nconst b = 2;');
  });

  it("keeps the name of a generic credential and redacts the value", () => {
    expect(redactForFactSheet(`apiKey: "${"abcd1234efgh5678ijkl"}", retries: 3`)).toBe(
      'apiKey: "<redacted>", retries: 3',
    );
  });

  it("keeps the connection string host and user, drops the password", () => {
    const out = redactForFactSheet(`db = "${FAKE.conn}"`);
    expect(out).toContain("db.internal:5432/app");
    expect(out).not.toContain("hunter2pass");
  });

  it("redacts a whole private key block", () => {
    const out = redactForFactSheet(`before\n${FAKE.pem}\nafter`);
    expect(out).toBe("before\n<redacted>\nafter");
  });

  it("is idempotent", () => {
    for (const [, text] of POSITIVE) {
      const once = redactForFactSheet(text);
      expect(redactForFactSheet(once)).toBe(once);
    }
  });

  it("drops invisible characters that could hide a key", () => {
    expect(redactForFactSheet("a​b﻿c")).toBe("abc");
  });
});

// Secret filter (spec section 8 / issue #22). Pure functions. Matched text is NEVER returned or logged:
// callers only ever see rule names.

import { stripInvisible } from "./text.js";

export interface SecretRule {
  name: string;
  /** Global. A named group `v` marks the part to redact; without it the whole match is redacted. */
  re: RegExp;
}

const B64 = "A-Za-z0-9+/_-";

export const SECRET_RULES: readonly SecretRule[] = [
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  {
    name: "aws-secret-key",
    re: /aws[_-]?secret[_-]?(?:access[_-]?)?key["']?\s*[:=]\s*["']?(?<v>[A-Za-z0-9/+=]{40})/gi,
  },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  { name: "slack-token", re: /\bxox[abeposr]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}/g },
  { name: "slack-webhook", re: /hooks\.slack\.com\/(?:services|workflows)\/[A-Za-z0-9/_-]{12,}/g },
  { name: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|\bwhsec_[A-Za-z0-9]{16,}/g },
  { name: "openai-anthropic-key", re: /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}/g },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "huggingface-token", re: /\bhf_[A-Za-z0-9]{30,}/g },
  { name: "sendgrid-key", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { name: "azure-storage-key", re: /AccountKey=(?<v>[A-Za-z0-9+/=]{40,})/g },
  {
    name: "private-key",
    // The header, plus the key body through the END line when present (the body has no recognisable shape).
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----)?/g,
  },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g },
  {
    name: "connection-string",
    // scheme://user:password@host
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`]+:(?!<redacted>)(?<v>[^\s@/'"`]+)@/gi,
  },
  { name: "bearer-token", re: /\bBearer\s+(?<v>[A-Za-z0-9._~+/=-]{20,})/g },
  {
    name: "generic-credential",
    // Issue #22: (api|secret|token|key)\s*[:=]\s*["'][^"']{16,}, widened to common credential names and backticks.
    re: /(?:api|secret|token|key|passw(?:or)?d|pwd|credentials?|auth)["']?\s*[:=]\s*["'`](?!<redacted>)(?<v>[^"'`\r\n]{16,})/gi,
  },
];

const ENTROPY_TOKEN = /[A-Za-z0-9+/=_-]{32,}/g;
export const ENTROPY_MIN_LENGTH = 32;
export const ENTROPY_THRESHOLD = 4.0;

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * A random-looking token: 32+ chars of the base64/base64url alphabet with entropy >= 4.0 that holds both a letter
 * and a digit. The letter+digit requirement keeps long identifiers and paths (letters and separators only) out.
 */
export function isHighEntropyToken(tok: string): boolean {
  return (
    tok.length >= ENTROPY_MIN_LENGTH &&
    /[A-Za-z]/.test(tok) &&
    /\d/.test(tok) &&
    shannonEntropy(tok) >= ENTROPY_THRESHOLD
  );
}

function normalizeForScan(text: string): string {
  return stripInvisible(text).normalize("NFKC");
}

function rulesHitting(text: string, rules: readonly SecretRule[]): string[] {
  const hits: string[] = [];
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    if (rule.re.test(text)) hits.push(rule.name);
    rule.re.lastIndex = 0;
  }
  return hits;
}

/** Decodes a base64/base64url token to text when the result is mostly printable ASCII, else null. */
function decodePrintable(tok: string): string | null {
  const clean = tok.replace(/=+$/, "");
  if (clean.length < 16 || !/^[A-Za-z0-9+/_-]+$/.test(clean)) return null;
  const decoded = Buffer.from(clean.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
  if (decoded.length < 12) return null;
  let printable = 0;
  for (const ch of decoded) {
    const c = ch.charCodeAt(0);
    if ((c >= 0x20 && c < 0x7f) || c === 0x0a || c === 0x0d || c === 0x09) printable++;
  }
  return printable / decoded.length >= 0.95 ? decoded : null;
}

const B64_TOKEN = new RegExp(`[${B64}]{16,}={0,2}`, "g");

/**
 * Names of the secret rules that match `text`, in rule order, without duplicates. Never returns matched text.
 * Zero-width and other invisible characters are removed and the text is NFKC-normalised first, so a key split by a
 * zero-width space or written in fullwidth letters is still found. Base64 tokens are also decoded and scanned
 * (reported as `base64:<rule>`).
 */
export function scanSecrets(text: string): string[] {
  const norm = normalizeForScan(text);
  const hits = rulesHitting(norm, SECRET_RULES);
  if ((norm.match(ENTROPY_TOKEN) ?? []).some(isHighEntropyToken)) hits.push("high-entropy");
  for (const tok of norm.match(B64_TOKEN) ?? []) {
    const decoded = decodePrintable(tok);
    if (decoded === null) continue;
    for (const name of rulesHitting(decoded, SECRET_RULES)) {
      const tagged = `base64:${name}`;
      if (!hits.includes(tagged)) hits.push(tagged);
    }
  }
  return hits;
}

const REDACTED = "<redacted>";

function redactWith(text: string, rules: readonly SecretRule[]): string {
  let out = text;
  for (const rule of rules) {
    out = out.replace(rule.re, (...args: unknown[]) => {
      const match = args[0] as string;
      const last = args[args.length - 1];
      const v = typeof last === "object" && last !== null ? (last as Record<string, string>).v : undefined;
      if (v === undefined) return REDACTED;
      const at = match.lastIndexOf(v);
      return at < 0 ? REDACTED : match.slice(0, at) + REDACTED + match.slice(at + v.length);
    });
    rule.re.lastIndex = 0;
  }
  return out;
}

/**
 * Replaces every secret in a function body with `<redacted>` before the fact sheet is sent anywhere. Code that
 * holds no secret is returned unchanged (invisible format characters are dropped, since they can hide a key).
 * Generic `name = "value"` credentials and connection strings keep their name and redact only the value.
 */
export function redactForFactSheet(body: string): string {
  let out = stripInvisible(body);
  const folded = out.normalize("NFKC");
  // Fullwidth or ligature spellings of a key: adopt the folded text only when it reveals a hit the raw text hides.
  if (folded !== out && rulesHitting(folded, SECRET_RULES).length > rulesHitting(out, SECRET_RULES).length) {
    out = folded;
  }
  out = redactWith(out, SECRET_RULES);
  out = out.replace(ENTROPY_TOKEN, (tok) => (isHighEntropyToken(tok) ? REDACTED : tok));
  out = out.replace(B64_TOKEN, (tok) => {
    const decoded = decodePrintable(tok);
    return decoded !== null && rulesHitting(decoded, SECRET_RULES).length > 0 ? REDACTED : tok;
  });
  return out;
}

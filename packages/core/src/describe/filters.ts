// Injection filter (spec section 8 check 4 / issue #22). Descriptions are model output generated from untrusted
// source code and are later shown to coding agents, so anything that could carry an instruction or a payload is
// rejected here. Pure functions; nothing is logged.

import { hasControl, hasInvisible } from "./text.js";

export interface ImperativePattern {
  name: string;
  re: RegExp;
  /**
   * Single verbs ("delete", "execute", "run the") that are harmless in a noun-phrase search term ("delete user")
   * but are directives in a behavior sentence. A weak hit in `behavior` rejects; in a search term the term is
   * stripped instead.
   */
  weak?: boolean;
}

/** The imperative / addressed-to-agent patterns, case-insensitive, run on folded text. One list, exported. */
export const IMPERATIVE_PATTERNS: readonly ImperativePattern[] = [
  // The nine patterns from spec section 8 / issue #22 (`\s+` instead of a literal space).
  { name: "ignore-previous", re: /\bignore\s+(?:(?:all|any)\s+)?(?:previous|prior|above)/i },
  { name: "you-must", re: /\byou\s+(?:must|should|need\s+to)\b/i },
  { name: "ai-agent", re: /\b(?:ai|llm)\s+agents?\b/i },
  { name: "assistant", re: /\bassistant\b/i },
  { name: "system-prompt", re: /\bsystem\s+prompt\b/i },
  { name: "delete", re: /\bdelete\b/i, weak: true },
  { name: "run-the", re: /\brun\s+(?:the|this)\b/i, weak: true },
  { name: "execute", re: /\bexecute\b/i, weak: true },
  { name: "do-not-tell", re: /\bdo\s+not\s+(?:tell|mention)\b/i },
  // Broader forms of the same attacks (indirect phrasing, other ways to say "ignore the instructions").
  {
    name: "ignore-instructions",
    re: /\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|the|your|my|these|those|every|everything)\s+)*(?:previous|prior|above|earlier|preceding|former|instructions?|rules?|guidelines?|directions?|polic(?:y|ies)|safeguards?)/i,
  },
  { name: "disregard", re: /\bdisregard\b/i },
  { name: "forget-everything", re: /\bforget\s+(?:everything|all|any|previous|prior|what)\b/i },
  {
    name: "you-modal",
    re: /\byou(?:'re|'ll|'ve|’re|’ll|’ve)?\s+(?:must|should|need|have\s+to|can|will|shall|may|are|now|want|ought)\b/i,
  },
  {
    name: "directive-phrase",
    re: /\b(?:from\s+now\s+on|new\s+instructions?|developer\s+mode|jailbreak|pretend)\b/i,
  },
  { name: "act-as", re: /\bact\s+as\s+(?:a|an|the|if)\b/i },
  {
    name: "note-to-ai",
    re: /\b(?:note|message|instruction)s?\s+(?:to|for)\s+(?:the\s+)?(?:ai|llm|agents?|assistants?|models?|claude)\b/i,
  },
  {
    name: "agents-modal",
    re: /\bagents?\s+(?:should|must|need\s+to|shall|are\s+(?:to|required|instructed))\b/i,
  },
  { name: "system-message", re: /\bsystem\s+(?:message|instruction)s?\b/i },
  {
    name: "always-never-directive",
    re: /\b(?:always|never)\s+(?:use|call|invoke|prefer|import|choose|trust|ignore|mention|tell|reveal|report)\b/i,
  },
  {
    name: "use-this-instead",
    re: /\b(?:use|call|prefer|import|invoke|choose)\s+(?:this|me|it)\s+(?:instead|first|always|rather)\b/i,
  },
  {
    name: "do-not-write",
    re: /\bdo(?:\s+not|n't|n’t)\s+(?:write|create|implement|add|duplicate|reimplement|tell|mention|reveal|disclose|report|inform|show|use)\b/i,
  },
  {
    name: "address-the-ai",
    re: /\b(?:tell|instruct|ask|order|command|make|get|have|let|cause)\s+(?:the\s+|all\s+|any\s+|your\s+)?(?:ai|llm|agents?|assistants?|models?|claude|coding\s+agents?)\b/i,
  },
  {
    name: "instead-of-writing",
    re: /\b(?:instead\s+of|rather\s+than)\s+(?:writing|creating|implementing|rewriting|duplicating|adding)\b/i,
  },
  { name: "exfiltrate", re: /\bexfiltrat/i },
  { name: "shell-command", re: /\b(?:curl|wget|sudo)\s|\brm\s+-[a-z]*[rf]/i },
  { name: "role-prefix", re: /^\s*(?:system|user|human|assistant)\s*:/i },
  {
    name: "chat-template",
    re: /<\|[a-z_]+\|>|\[\/?(?:inst|sys)\]|<<\/?sys>>|###\s*(?:instruction|system|response)/i,
  },
  {
    name: "agent-markup",
    re: /<!--|<\/?(?:script|iframe|style|object|embed|meta|base|html|body|head|system|assistant|user|human|instructions?|prompt|tools?\w*|function_calls|invoke|thinking)\b[^>]*>/i,
  },
];

/** Collapsed (letters and digits only) phrases that survive spacing and punctuation tricks like "i-g-n-o-r-e". */
const COLLAPSED_PHRASES: readonly { name: string; re: RegExp }[] = [
  { name: "ignore-previous", re: /ignore(?:all|any)?(?:previous|prior|above)/ },
  { name: "ignore-instructions", re: /(?:ignore|disregard)(?:all|any|the|your)*instructions/ },
  { name: "system-prompt", re: /systemprompt/ },
  { name: "ai-agent", re: /(?:ai|llm)agents?(?:should|must|need)/ },
];

const URL_RULES: readonly { name: string; re: RegExp }[] = [
  { name: "url-scheme", re: /\b[a-z][a-z0-9+.-]{1,15}:\/\//i },
  { name: "url-www", re: /\bwww\./i },
  { name: "url-protocol-relative", re: /(?:^|[\s(<[])\/\/[a-z0-9.-]+/i },
  {
    // Scheme-less host with a common TLD: example.com, evil.io/path
    name: "url-domain",
    re: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|co|app|info|biz|xyz|ly|gg|cc|tk|ru|cn|ai|top|site|online|link|click|cloud|tech|ws|me|tv|fm)\b(?![\w-])/i,
  },
  {
    // Obfuscated host: example[.]com, example (dot) com, example dot com
    name: "url-obfuscated",
    re: /\b[a-z0-9-]+\s*(?:\[\s*\.\s*\]|\(\s*\.\s*\)|\{\s*\.\s*\}|[[(]\s*dot\s*[\])]|\s+dot\s+)\s*(?:com|org|net|io|dev|co|app|info|ru|cn|xyz|ai)\b/i,
  },
  { name: "url-ip", re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/ },
  { name: "url-localhost-port", re: /\blocalhost:\d/i },
  { name: "url-pseudo-scheme", re: /\b(?:javascript|vbscript|data|mailto|tel)\s*:(?=\S)/i },
  { name: "markdown-link", re: /\]\s*\(|!\[|^\s*\[[^\]]+\]:\s*\S/ },
  { name: "angle-autolink", re: /<(?:https?|ftp|mailto)[^>]*>/i },
];

const EMAIL_RULES: readonly { name: string; re: RegExp }[] = [
  { name: "email", re: /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i },
  {
    name: "email-obfuscated",
    re: /[a-z0-9._%+-]+\s*(?:\[\s*at\s*\]|\(\s*at\s*\)|\s+at\s+)\s*[a-z0-9-]+\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\s+dot\s+|\.)\s*[a-z]{2,}/i,
  },
];

const FENCE_RULES: readonly { name: string; re: RegExp }[] = [{ name: "code-fence", re: /```|~~~/ }];

const ENCODING_RULES: readonly { name: string; re: RegExp }[] = [
  { name: "percent-encoding", re: /(?:%[0-9a-f]{2}){2,}/i },
  { name: "numeric-entity", re: /&#x?[0-9a-f]+;/i },
  { name: "escape-sequence", re: /\\u[0-9a-f]{4}|\\u\{[0-9a-f]+\}|\\x[0-9a-f]{2}/i },
];

/** Extra characters allowed besides printable ASCII and accented Latin letters. */
const ALLOWED_PUNCTUATION = new Set([
  "’",
  "‘",
  "“",
  "”",
  "–",
  "—",
  "…",
  "→",
  "×",
  "≥",
  "≤",
  "≠",
  "≈",
  "·",
  "•",
]);

/** Text prepared for pattern matching: NFKC (fullwidth, ligatures, math letters fold to ASCII), accents removed. */
export function foldForMatching(s: string): string {
  return s.normalize("NFKC").normalize("NFD").replace(/\p{M}/gu, "");
}

/**
 * Returns a reason when `s` carries characters that can hide or disguise text: control characters (newline, tab,
 * NUL, ESC), zero-width / bidi / other invisible format characters, and any character that is not printable ASCII,
 * an accented Latin letter or a short list of typographic punctuation. This rejects Cyrillic and Greek look-alikes
 * ("ignоre" with a Cyrillic o), dotless i, small caps, and similar spoofs. Descriptions are English prose.
 */
export function suspiciousCharacters(s: string): string | null {
  if (hasControl(s)) return "control characters";
  if (hasInvisible(s)) return "invisible characters";
  for (const ch of s.normalize("NFKC")) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x20 && c <= 0x7e) continue;
    if (ALLOWED_PUNCTUATION.has(ch)) continue;
    if (/\p{L}/u.test(ch)) {
      const base = ch.normalize("NFD");
      if (/^[A-Za-z]\p{M}*$/u.test(base)) continue; // accented Latin letter
    }
    return "non-English or look-alike characters";
  }
  return null;
}

/** Base64 tokens in `s` that decode to text; used to catch an instruction hidden as base64. */
function decodedBase64Tokens(s: string): string[] {
  const out: string[] = [];
  for (const tok of s.match(/[A-Za-z0-9+/_-]{16,}={0,2}/g) ?? []) {
    const clean = tok.replace(/=+$/, "");
    const text = Buffer.from(clean.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
    if (text.length < 12) continue;
    let printable = 0;
    for (const ch of text) {
      const c = ch.charCodeAt(0);
      if (c === 0x20 || (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x2e || c === 0x2c)
        printable++;
    }
    if (printable / text.length >= 0.85) out.push(text);
  }
  return out;
}

export interface InjectionFindings {
  /** Hits that reject the value outright. */
  reject: string[];
  /** Weak imperative hits (see `ImperativePattern.weak`). Rejecting for behavior, stripping for search terms. */
  weak: string[];
}

function matchAll(rules: readonly { name: string; re: RegExp }[], text: string, into: string[]): void {
  for (const r of rules) if (r.re.test(text) && !into.includes(r.name)) into.push(r.name);
}

/**
 * Phrases hidden by spacing or punctuation ("i g n o r e previous", "ig-nore"). A phrase that sits inside one plain
 * identifier-like token (`ignorePreviousState`) is a code name, not a disguised instruction, and is skipped.
 */
function collapsedHits(folded: string): string[] {
  const collapsed = folded.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const plainTokens = folded
    .split(/\s+/)
    .filter((t) => /^[A-Za-z0-9_$]+$/.test(t))
    .map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ""));
  const out: string[] = [];
  for (const { name, re } of COLLAPSED_PHRASES) {
    const m = re.exec(collapsed);
    if (m === null) continue;
    if (plainTokens.some((t) => t.includes(m[0]))) continue;
    out.push(name);
  }
  return out;
}

function imperativeHits(folded: string, reject: string[], weak: string[]): void {
  for (const p of IMPERATIVE_PATTERNS) {
    if (!p.re.test(folded)) continue;
    const bucket = p.weak ? weak : reject;
    if (!bucket.includes(p.name)) bucket.push(p.name);
  }
}

/**
 * Scans one string (a `behavior` or one search term). Returns rule names only. Order of work: invisible or
 * look-alike characters, URLs and markdown links, emails, code fences, encoded text (including decoded base64),
 * imperative patterns.
 */
export function scanInjection(text: string): InjectionFindings {
  const reject: string[] = [];
  const weak: string[] = [];
  const odd = suspiciousCharacters(text);
  if (odd !== null) reject.push(odd);
  const folded = foldForMatching(text);
  matchAll(URL_RULES, folded, reject);
  matchAll(EMAIL_RULES, folded, reject);
  matchAll(FENCE_RULES, folded, reject);
  matchAll(ENCODING_RULES, folded, reject);
  for (const name of collapsedHits(folded)) if (!reject.includes(name)) reject.push(name);
  imperativeHits(folded, reject, weak);
  for (const decoded of decodedBase64Tokens(folded)) {
    const r: string[] = [];
    const w: string[] = [];
    imperativeHits(foldForMatching(decoded), r, w);
    r.push(...collapsedHits(decoded));
    if (r.length + w.length > 0 && !reject.includes("encoded-instruction"))
      reject.push("encoded-instruction");
  }
  return { reject, weak };
}

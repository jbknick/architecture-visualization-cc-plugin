// Injection filter, defence in depth (spec section 8 check 7). The main defence is structural: the shape rules in
// shape.ts and the grounding rules in identifiers.ts accept only text that looks like a description of a function.
// This file keeps a SMALL set of high-precision patterns for what the structure could still let through (an
// "ignore previous instructions" spelled with plain words, chat-template tokens, role prefixes, markup). It does not
// try to list every imperative; standalone words such as "assistant", "delete", "execute", "run the" are not here.
// Every regex is linear: no nested quantifiers, repetition bounded, inputs capped at 400 characters by the caller.

import { hasControl, hasInvisible } from "./text.js";

export interface ImperativePattern {
  name: string;
  re: RegExp;
}

/** The high-precision instruction patterns, case-insensitive, run on folded text. One list, exported. */
export const IMPERATIVE_PATTERNS: readonly ImperativePattern[] = [
  {
    // ignore / disregard / forget / override / bypass ... previous / above / all ... instructions / rules
    name: "ignore-instructions",
    re: /\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|the|your|my|these|those|every|everything|of)\s+){0,4}(?:previous|prior|above|earlier|preceding|former|instructions?|rules?|guidelines?|directions?|polic(?:y|ies)|safeguards?)\b/i,
  },
  {
    // The same attack in the third person, which passes the first-word shape rule: "Ignores previous instructions".
    name: "ignores-instructions",
    re: /\b(?:ignores|disregards|forgets)\s+(?:(?:all|any|the|your|my|these|those|every|of)\s+){0,4}(?:previous|prior|above|preceding|instructions?|guidelines?|system\s+prompt)\b/i,
  },
  { name: "do-not-tell", re: /\bdo(?:\s+not|n't)\s+(?:tell|mention|reveal|disclose|inform|trust)\b/i },
  { name: "system-prompt-label", re: /\bsystem\s+prompt\s*:/i },
  { name: "role-prefix", re: /^\s*(?:system|user|human|assistant)\s*:/i },
  {
    name: "chat-template",
    re: /<\|[a-z_]{1,30}\|>|\[\/?(?:inst|sys)\]|<<\/?sys>>|###\s{0,3}(?:instruction|system|response)/i,
  },
  {
    name: "agent-markup",
    re: /<!--|<\/?(?:script|iframe|style|object|embed|meta|base|html|body|head|system|assistant|user|human|instructions?|prompt|tools?\w{0,20}|function_calls|invoke|thinking)\b[^>]{0,200}>/i,
  },
  {
    // Hosts spelled so that no dotted token exists: "hxxp", "example[.]com", "attacker dot sh".
    name: "obfuscated-host",
    re: /\bhxxps?\b|\[\s*\.\s*\]|\(\s*\.\s*\)|[[(]\s*dot\s*[\])]|\b[a-z0-9-]{1,30}\s+dot\s+(?:com|org|net|io|sh|dev|app|ru|cn|xyz|zip|us|de|pw|co|ai|info|biz|me|tv|cc|tk|ly|gg|top|site|online|link|click|cloud|tech)\b/i,
  },
  { name: "markdown-link", re: /\[[^\]]{0,100}[A-Za-z]{3}[^\]]{0,100}\]\(|!\[/ },
  { name: "url-scheme", re: /\b[a-z][a-z0-9+.-]{1,15}:\/\//i },
  { name: "shell-command", re: /\brm\s+-[a-z]{0,6}[rf]|\b(?:curl|wget)\s+-|\|\s*(?:sh|bash)\b/i },
];

/** Collapsed (letters and digits only) phrases that survive spacing and punctuation tricks like "i-g-n-o-r-e". */
const COLLAPSED_PHRASES: readonly { name: string; re: RegExp }[] = [
  {
    name: "ignore-instructions",
    re: /(?:ignore|disregard)(?:all|any|the|your)?(?:previous|prior|above|instructions|rules)/,
  },
];

/** Text prepared for pattern matching: NFKC (fullwidth, ligatures, math letters fold to ASCII), accents removed. */
export function foldForMatching(s: string): string {
  return s.normalize("NFKC").normalize("NFD").replace(/\p{M}/gu, "");
}

/**
 * Returns a reason when `s` carries characters that can hide or disguise text: control characters (newline, tab,
 * NUL, ESC), zero-width / bidi / other invisible format characters, and any character that is not printable ASCII
 * after NFKC folding. Descriptions are English prose.
 */
export function suspiciousCharacters(s: string): string | null {
  if (hasControl(s)) return "control characters";
  if (hasInvisible(s)) return "invisible characters";
  for (const ch of s.normalize("NFKC")) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c > 0x7e) return "non-ASCII characters";
  }
  return null;
}

export interface InjectionFindings {
  /** Hits that reject the value outright. */
  reject: string[];
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

/** Scans one string (a `behavior`, a search term, or fields joined together). Returns rule names only. */
export function scanInjection(text: string): InjectionFindings {
  const reject: string[] = [];
  const odd = suspiciousCharacters(text);
  if (odd !== null) reject.push(odd);
  const folded = foldForMatching(text);
  for (const p of IMPERATIVE_PATTERNS) if (p.re.test(folded) && !reject.includes(p.name)) reject.push(p.name);
  for (const name of collapsedHits(folded)) if (!reject.includes(name)) reject.push(name);
  return { reject };
}

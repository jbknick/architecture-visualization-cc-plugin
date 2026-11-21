// Grounding (spec section 8 check 6). Every token of `behavior`, of each search term and of `suggestedName` must be
//   (a) an English or programming word (wordlist.ts, with inflection and prefix handling),
//   (b) a small number (fewer than seven digits, a clock time, a size such as 30s or 4x),
//   (c) grounded in the fact sheet: an identifier, path, file name, signature name, callee, return type or doc token,
//       or a SUB-WORD of one (camelCase, PascalCase, snake_case, kebab-case, path segments and file names are split
//       into lower-case parts; `handleStripeWebhook` grounds "stripe" and "webhook", `later-work-controller.ts`
//       grounds "later-work"), or
//   (d) on the stop list (function words).
// Anything else is rejected with reason `identifier`. Hyphen and slash compounds are accepted only when they are on the
// ordinary-English allow-list, grounded as a whole, or when EVERY part is grounded in the fact sheet: two dictionary
// words are not enough ("evil-pad", "auth/bypass"). A dotted or host-like token is never grounded by a string literal
// or a default parameter value; only by identifiers, paths, callees and relative import file names. Every input the
// scanner reads is capped before any regex runs.

import { parseId } from "../ids.js";
import type { FactSheet } from "../types.js";
import { isCredentialName } from "./secrets.js";
import { echoToken, tokenize } from "./text.js";
import { derivesFrom, isBaseWord, isContraction, isStopWord, isWord, stemsOf } from "./wordlist.js";

export const GROUNDING_CAPS = {
  signature: 400,
  doc: 2000,
  body: 8000,
  path: 300,
  callee: 200,
  callees: 50,
} as const;

/** What the fact sheet grounds. `names` hold whole tokens, `words` lower-case sub-words, `secretWords` credential values. */
export interface Grounding {
  names: Set<string>;
  words: Set<string>;
  secretWords: Set<string>;
}

/** Product and platform names and spellings with capitals or digits that the plain word test cannot see. */
const STOP_WORDS = `
javascript typescript nodejs github gitlab bitbucket linkedin youtube macos ios android oauth jwt uuid guid
postgresql sqlite mysql mongodb dynamodb graphql websocket localstorage sessionstorage indexeddb devtools formdata
urlsearchparams abortcontroller settimeout setinterval cleartimeout clearinterval addeventlistener
removeeventlistener queryselector getelementbyid innerhtml textcontent classname parseint parsefloat tostring
tolowercase touppercase foreach hasownproperty isarray isnan nodelist htmlelement eventemitter xmlhttprequest
camelcase pascalcase snakecase kebabcase
json_object json_array json_extract json_each json_group_array json_group_object
`;
export const IDENTIFIER_STOP_LIST: ReadonlySet<string> = new Set(STOP_WORDS.split(/\s+/).filter(Boolean));

/** Ordinary hyphenated or slashed English and technical compounds, and well-known file names. Case-insensitive. */
const HYPHENATED_TEXT = `
read-only write-only non-empty case-insensitive case-sensitive built-in built-ins in-memory in-place in-flight
on-disk on-demand on-screen up-to-date out-of-date real-time run-time long-running long-lived short-lived
single-use one-time one-off one-way two-way two-factor multi-factor multi-line single-line multi-step multi-select
multi-tenant non-null non-zero non-blank non-negative non-numeric non-ascii non-existent non-breaking non-trivial
non-matching non-nullable pre-filled pre-existing pre-commit pre-built so-called well-known high-level low-level
top-level first-class third-party end-to-end front-end back-end full-text full-screen full-width drag-and-drop
copy-paste pass-through round-trip lower-case upper-case auto-save auto-complete auto-refresh auto-generated
self-signed self-contained self-hosted cross-origin cross-platform cross-site back-off check-in sign-in sign-out
sign-up log-in log-out opt-in opt-out set-up time-out time-based time-zone rate-limited re-run re-render
re-fetch re-try re-queue re-index re-order re-use e-mail x-axis y-axis ad-hoc per-user per-file per-request
user-defined user-provided user-facing client-side server-side key-value name-value space-separated
comma-separated line-by-line step-by-step one-to-many many-to-many one-to-one first-in first-out last-in
read-write deep-copy deep-clone shallow-copy json-ld llms.txt llms-full.txt plain-text command-line content-type content-length user-agent cache-control set-cookie if-none-match accept-language
x-forwarded-for retry-after utf-8 utf-16 sha-1 sha-256 sha-512 iso-8601 base-64 and/or client/server read/write
true/false yes/no on/off input/output i/o ci/cd tcp/ip http/1.1 http/2 hh:mm
aes-128-cbc aes-256-cbc aes-128-gcm aes-256-gcm aes-gcm aes-cbc rsa-oaep rsa-pss hmac-sha256 sha-384 x-www-form-urlencoded
strict-transport-security content-security-policy x-frame-options x-content-type-options referrer-policy
permissions-policy access-control-allow-origin cross-origin-opener-policy cross-origin-resource-policy
multi-part look-up look-ahead look-behind write-ahead time-to-live key-derivation
camelcase snake_case kebab-case title-case camel-case pascal-case signed-in signed-out human-readable machine-readable percent-encoded url-safe html-safe type-safe thread-safe fail-safe fail-fast fire-and-forget first-come last-modified last-write-wins
case-folding word-by-word day-to-day day-of-week one-based zero-based
package.json tsconfig.json package-lock.json .env .gitignore .npmrc readme.md index.ts index.js index.tsx
schema.org node_modules pnpm-lock.yaml yarn.lock docker-compose.yml node.js next.js vue.js d3.js three.js e.g i.e
robots.txt sitemap.xml favicon.ico manifest.json license.md changelog.md
`;
const HYPHENATED_OK: ReadonlySet<string> = new Set(HYPHENATED_TEXT.split(/\s+/).filter(Boolean));

/** Well-known mixed letter-and-digit names. Lower-case. */
const KNOWN_ALNUM: ReadonlySet<string> = new Set(
  `oauth2 base64 base32 sha1 sha256 sha384 sha512 base64url base32hex md5 utf8 utf16 es5 es6 es2015 es2020 es2022 http2 http3 ipv4 ipv6
  i18n l10n a11y k8s web3 ec2 s3 sqs sns uint8 uint16 uint32 int8 int16 int32 int64 float32 float64 vec2 vec3 vec4
  mp3 mp4 h264 x86 x64 arm64 win32 py3 python3 node18 node20 react18 vue3 angular2 oauth1 jwt2 tls1 ssl3 ecmascript2020
  e2e 2fa b2b b2c p2p 3d 2d 4k 5g aes128 aes256 hs256 rs256 es256 ed25519 x25519 pbkdf2 argon2 argon2id sha3 bm25 fts5 gpt4
  html5 css3 utf32 crc32 md4 ripemd160 vp9 av1 h265 ipv`.split(/\s+/),
);

const SHORT_ALNUM = /^[A-Za-z]\d{1,2}$|^\d{1,2}[A-Za-z]$/;
const UNIT_NUMBER = /^\d{1,4}(?:st|nd|rd|th|x|xx|px|ms|s|m|h|d|kb|mb|gb|k)$/i;
const NUMBER_UNIT_COMPOUND =
  /^\d{1,4}-(?:byte|bit|digit|character|char|letter|hour|minute|second|day|week|month|year|row|item|line|word|point|column|part|level|way|step|page|time|key|value|field|space)s?$/i;
const TIME = /^\d{1,2}:\d{2}(?:-\d{1,2}:\d{2})?$/;
const SMALL_NUMBER = /^-?\d{1,6}$/;
const DECIMAL = /^\d{1,4}\.\d{1,3}$/;
const ADDRESS_WORDS = new Set(
  "to from at on via host ip address server domain url ping connect connects connecting port".split(" "),
);
/** Prefixes that may build a hyphenated compound from any one dictionary word: "non-existent", "multi-tenant". */
const COMPOUND_SUFFIX =
  /^([a-z]{3,14})-(?:based|only|side|level|specific|aware|safe|free|like|wide|friendly|first|bound|ready|scoped|driven|encoded|decoded|readable|formatted|typed|named|sized|cased|sorted|separated|delimited|insensitive|sensitive|in|out|up|case|style)$/;
const COMPOUND_PREFIX = /^(?:non|multi|cross|semi|anti|sub|inter|intra|pseudo)-([a-z]{3,16})$/;

const FUNCTION_WORDS = new Set(
  "for by of to in on the up a an and or with at as is not over per out off from".split(" "),
);

/** A token that looks like a code identifier: lower/digit then capital (camelCase, PascalCase) or `x_y` (snake_case). */
export function isIdentifierLike(token: string): boolean {
  if (IDENTIFIER_STOP_LIST.has(token.toLowerCase())) return false;
  return /[a-z0-9][A-Z]/.test(token) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(token);
}

const IDENT = /[A-Za-z_$][\w$]*/g;
const DOTTED = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/g;
const STANDALONE_DECIMAL = /(?<![\w.])\d{1,4}\.\d{1,3}(?![\w.])/g;

/** Source code with string literals (including template literals) and comments blanked out. Linear time. */
export function stripLiteralsAndComments(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i] as string;
    const next = code[i + 1];
    if (c === "/" && next === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? code.length : end + 2;
      out += " ";
    } else if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < code.length && code[i] !== c) {
        if (code[i] === "\\") i++;
        i++;
      }
      i++;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Path and name of a symbol id `sym:<repo>:src/a.ts#Class.method~2` (or a bare `src/a.ts#fn`). */
function idParts(id: string): { path: string; name: string } {
  const parsed = parseId(id);
  const bare = (parsed?.kind === "sym" ? `${parsed.path}#${parsed.name}` : id.replace(/^sym:/, "")).slice(
    0,
    GROUNDING_CAPS.path + 100,
  );
  const hash = bare.indexOf("#");
  if (hash < 0) return { path: "", name: bare };
  return { path: bare.slice(0, hash), name: bare.slice(hash + 1).replace(/~\d+$/, "") };
}

/** Words of a camelCase / PascalCase / snake_case / kebab-case identifier: `parseHTMLString_v2` -> parse, HTML, String, v2. */
export function splitIdentifierWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_$.\-/]+/)
    .filter(Boolean);
}

/**
 * Everything a description may mention beyond ordinary words: the names the index itself produced and the identifiers
 * of the code. Not the text of string literals or comments of the body (an attacker controls those), except single
 * UPPER_SNAKE constants, and never a dotted token taken from a literal or a default value.
 */
export function groundingNames(sheet: FactSheet): Grounding {
  const names = new Set<string>();
  const words = new Set<string>();
  const secretWords = new Set<string>();

  const addWords = (name: string) => {
    for (const w of splitIdentifierWords(name)) if (/^[A-Za-z]+$/.test(w)) words.add(w.toLowerCase());
  };
  /** A whole name, its sub-words and, for kebab names, every run of adjacent parts ("later-work" from "later-work-controller"). */
  const addName = (s: string) => {
    if (s === "" || s.length > 200) return;
    names.add(s);
    addWords(s);
    if (s.includes("-")) {
      const parts = s.split("-").filter(Boolean);
      if (parts.length <= 8) {
        for (let i = 0; i < parts.length; i++)
          for (let j = i + 1; j <= parts.length; j++) names.add(parts.slice(i, j).join("-"));
      }
    }
  };
  const addIdents = (s: string, dotted: boolean) => {
    for (const m of s.match(IDENT) ?? []) addName(m);
    if (dotted) for (const m of s.match(DOTTED) ?? []) names.add(m);
    for (const m of s.match(STANDALONE_DECIMAL) ?? []) names.add(m);
  };

  const { path: idPath, name } = idParts(sheet.id);
  addName(name);
  for (const part of name.split(".")) addName(part);
  for (const p of [sheet.path.slice(0, GROUNDING_CAPS.path), idPath]) {
    if (p !== "") names.add(p);
    for (const seg of p.split("/")) {
      addName(seg);
      const dot = seg.indexOf(".", 1);
      if (dot > 0) addName(seg.slice(0, dot));
      const last = seg.lastIndexOf(".");
      if (last > 0) addName(seg.slice(0, last));
    }
  }
  // Signature and return type: literals and default values blanked first, so `(host = "evil.sh")` grounds nothing.
  addIdents(stripLiteralsAndComments(sheet.signature.slice(0, GROUNDING_CAPS.signature)), true);
  addIdents(stripLiteralsAndComments((sheet.returnType ?? "").slice(0, GROUNDING_CAPS.signature)), true);
  for (const c of sheet.callees.slice(0, GROUNDING_CAPS.callees)) {
    const cc = c.slice(0, GROUNDING_CAPS.callee);
    names.add(cc);
    for (const part of cc.split(".")) addName(part);
  }
  // The host-written `runsWhen` text (Go `init`, #372): plain words, no code or literal behind it.
  addIdents((sheet.runsWhen ?? "").slice(0, GROUNDING_CAPS.doc), false);
  // Doc: identifiers and words, but a dotted chain ("evil.sh") is removed first; only the index's own dotted names count.
  const doc = (sheet.doc ?? "").slice(0, GROUNDING_CAPS.doc).replace(DOTTED, " ");
  addIdents(doc, false);
  const body = sheet.body.slice(0, GROUNDING_CAPS.body);
  addIdents(stripLiteralsAndComments(body), false);
  // Relative import specifiers: only the file name counts ("./later-work-controller.js" grounds that file's name).
  for (const m of body.matchAll(
    /(?:from|import|require)\s{0,3}\(?\s{0,3}["'](\.{1,2}\/[^"'\s]{1,120})["']/g,
  )) {
    const file = (m[1] as string).split("/").pop() ?? "";
    const stem = file.replace(/\.[a-z]+$/, "");
    addName(file);
    addName(stem);
  }
  // Single UPPER_SNAKE string constants ("NOT_FOUND") are the vocabulary of a function; a lone word cannot be a host.
  for (const m of body.matchAll(/["'`]([A-Z][A-Z0-9]{0,20}(?:_[A-Z0-9]{1,20}){1,5})["'`]/g))
    addName(m[1] as string);
  // Values assigned to credential names: any word copied from one is a leak, even when it is an ordinary word.
  // Go adds the short declaration `:=` and a declaration with a type between the name and `=`.
  for (const m of [
    ...body.matchAll(
      /(?<n>[A-Za-z_$][\w$-]{0,60})["']?\s{0,5}(?::=|[:=])\s{0,5}(["'`])(?<v>[^"'`\r\n]{4,100})\2/g,
    ),
    ...body.matchAll(
      /\b(?:var|const)[ \t]{1,10}(?<n>[A-Za-z_]\w{0,60})[ \t]{1,10}[*[\]A-Za-z_][\w.*[\]]{0,40}[ \t]{0,5}=\s{0,5}(["'`])(?<v>[^"'`\r\n]{4,100})\2/g,
    ),
  ]) {
    const g = m.groups as { n: string; v: string };
    if (g.v === "<redacted>" || !isCredentialName(g.n)) continue;
    for (const w of g.v.toLowerCase().split(/[^a-z0-9]+/))
      if (w.length >= 3 && !words.has(w)) secretWords.add(w);
    const whole = g.v.toLowerCase();
    if (!words.has(whole)) secretWords.add(whole);
  }
  return { names, words, secretWords };
}

/** Back-compat name: the grounding of a fact sheet. */
export function factSheetTokens(sheet: FactSheet): Grounding {
  return groundingNames(sheet);
}

function wordGrounded(lower: string, g: Grounding): boolean {
  return (
    isWord(lower) ||
    isStopWord(lower) ||
    IDENTIFIER_STOP_LIST.has(lower) ||
    g.words.has(lower) ||
    (lower.length >= 4 && derivesFrom(lower, (b) => isBaseWord(b) || g.words.has(b)))
  );
}

/** True when `token` is an ordinary word, a small number, on the stop list, or grounded in the fact sheet. */
export function isGrounded(token: string, g: Grounding): boolean {
  if (SMALL_NUMBER.test(token) || isContraction(token)) return true;
  if (/^[A-Za-z]+$/.test(token)) {
    if (token.length === 1) return true;
    // camelCase or PascalCase with a lower-case word inside: an identifier, so it must be a name of the fact sheet
    // (or a product spelling such as "GitHub" whose lower-case form is a known word).
    if (/[a-z][A-Z]/.test(token))
      return (
        g.names.has(token) || IDENTIFIER_STOP_LIST.has(token.toLowerCase()) || isWord(token.toLowerCase())
      );
    return wordGrounded(token.toLowerCase(), g);
  }
  if (g.names.has(token)) return true;
  const lower = token.toLowerCase();
  if (HYPHENATED_OK.has(lower) || KNOWN_ALNUM.has(lower) || IDENTIFIER_STOP_LIST.has(lower)) return true;
  if (/^[a-z]+-[a-z]+$/.test(lower) && stemsOf(lower).some((s) => HYPHENATED_OK.has(s))) return true;
  if (
    TIME.test(token) ||
    UNIT_NUMBER.test(token) ||
    NUMBER_UNIT_COMPOUND.test(token) ||
    SHORT_ALNUM.test(token)
  )
    return true;
  if (DECIMAL.test(token)) return false; // "8.8" can be a host; only a number the code itself holds (in names) counts
  const pre = COMPOUND_PREFIX.exec(lower);
  if (pre !== null && isWord(pre[1] as string)) return true;
  const suf = COMPOUND_SUFFIX.exec(lower);
  if (suf !== null && isWord(suf[1] as string)) return true;
  const alnum =
    /^[a-z]\d{1,2}-(?:based|backed|only|side|level|specific|aware|safe|free|like|wide|friendly|first|bound|ready|driven)$/.exec(
      lower,
    );
  if (alnum !== null) return true;
  if (/^[a-z]+(?:-[a-z]+){1,4}$/.test(lower)) {
    const parts = lower.split("-");
    // "size-limited", "server-captured": a noun and a participle, both ordinary words.
    if (parts.length === 2 && /(?:ed|ing)$/.test(parts[1] as string) && parts.every((p) => isWord(p)))
      return true;
    // "waiting-for-review", "in-app", "up-to-date": a function word and ordinary words around it.
    if (parts.some((p) => FUNCTION_WORDS.has(p)) && parts.every((p) => isWord(p) || isStopWord(p)))
      return true;
  }
  // Compound of letter parts joined by hyphens, one slash or underscores: every part must come from the fact sheet.
  if (/^[A-Za-z]+(?:[-_/][A-Za-z]+){1,5}$/.test(token) && (token.match(/\//g) ?? []).length <= 1) {
    return token.split(/[-_/]/).every((p) => g.words.has(p.toLowerCase()) || isStopWord(p.toLowerCase()));
  }
  return false;
}

/** Tokens of `text` that are not grounded (deduplicated, original spelling). */
export function ungroundedTokens(text: string, g: Grounding): string[] {
  const bad: string[] = [];
  const tokens = tokenize(text);
  // Three or more small numbers in a row spell an address ("192 168 1 1").
  let run = 0;
  tokens.forEach((t, i) => {
    run = SMALL_NUMBER.test(t) ? run + 1 : 0;
    if (run >= 3 && !bad.includes(t)) bad.push(t);
    if (bad.includes(t)) return;
    // A decimal ("1.5 MB", "version 2.0") is a number, except right after a word that introduces an address.
    if (DECIMAL.test(t) && !g.names.has(t) && !ADDRESS_WORDS.has((tokens[i - 1] ?? "").toLowerCase())) return;
    if (!isGrounded(t, g)) bad.push(t);
  });
  return bad;
}

/** Ungrounded tokens in `behavior` (deduplicated). */
export function unknownIdentifiers(behavior: string, sheet: FactSheet): string[] {
  return ungroundedTokens(behavior, groundingNames(sheet));
}

/** Tokens of `text` that equal a word copied from a string value assigned to a credential name. */
export function secretTokens(text: string, g: Grounding): string[] {
  if (g.secretWords.size === 0) return [];
  return tokenize(text).filter((t) => g.secretWords.has(t.toLowerCase()));
}

/** Detail text for ungrounded tokens: at most five, opaque ones shortened to 12 characters and an ellipsis. */
export function describeUngrounded(tokens: readonly string[]): string {
  return `not in the fact sheet: ${tokens.slice(0, 5).map(echoToken).join(", ")}`;
}

// Grounding (spec section 8 check 6). A token in `behavior`, a search term or `suggestedName` is "plain" when it is an
// ordinary lower-case English-looking word, a short acronym or a small number; plain tokens are not checked. Every
// other token (camelCase, snake_case, host-like, path-like, package-like, version-like, kebab-case, long or mixed
// alphanumeric, hex, big integers) must appear among the fact sheet's NAMES or on a committed allow-list. Names are
// the id, path segments, signature, callees, return type, doc words and identifiers in the body code, but never text
// inside string literals or comments of the body. This is structural: bait package names, hosts in any notation and
// opaque secrets fail because nothing grounds them, without listing any attack phrase.

import type { FactSheet } from "../types.js";
import { echoToken, tokenize } from "./text.js";

/**
 * Common English words and well-known product or platform terms. Compared case-insensitively. Plain words never need
 * to be here; the camelCase, ALL-CAPS and mixed ones do (GitHub, TypeScript, SELECT, README).
 */
const STOP_WORDS = `
a an and are as at be but by can do for from has have if in into is it its not of on or so than that the then
there these this to was were when where which while who will with without about after again all also any back
because been before both each either else every few first just last like more most much must never new next no
none now off often once only other out over own per same should since some still such than too under until up
upon very via what whether why would yet
javascript typescript nodejs node react reactjs nextjs vue angular svelte redux json yaml xml html css sql http
https url uri api rest graphql grpc websocket websockets oauth jwt uuid guid csv utf ascii regex cli sdk ui ux id
github gitlab bitbucket npm pnpm yarn webpack vite eslint prettier jest vitest postgresql postgres mysql sqlite
mongodb redis dynamodb firebase supabase openai anthropic claude aws gcp azure docker kubernetes linux macos ios
android windows chrome firefox safari youtube linkedin twitter facebook stripe sentry
camelcase pascalcase snakecase kebabcase
localstorage sessionstorage indexeddb devtools formdata urlsearchparams abortcontroller
settimeout setinterval cleartimeout clearinterval addeventlistener removeeventlistener queryselector
getelementbyid innerhtml textcontent classname parseint parsefloat tostring tolowercase touppercase foreach
hasownproperty isarray isnan promiseall
usestate useeffect useref usememo usecallback usecontext usereducer uselayouteffect
nodelist htmlelement eventemitter
delete select insert update create upsert options connect replace patch readme changelog license dockerfile makefile
typeorm drizzle prisma zod trpc orpc hono tanstack nuxt remix astro bun deno vercel netlify cloudflare heroku
openapi swagger webassembly webrtc webgl xmlhttprequest websocketserver bcrypt argon scrypt pbkdf hmac
postgresql sqlite mariadb elasticsearch rabbitmq kafka nginx apache
httponly samesite pbkdf2 argon2 argon2id bcrypt sha3 hs256 rs256 es256 aes256 aes128 ed25519 x25519 secp256k1
snake_case kebab-case title-case camel-case pascal-case
`;

export const IDENTIFIER_STOP_LIST: ReadonlySet<string> = new Set(
  STOP_WORDS.split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase()),
);

/** Ordinary hyphenated or slashed English and technical compounds. Case-insensitive. Kebab-case names are not here. */
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
read-write content-type content-length user-agent cache-control set-cookie if-none-match accept-language
x-forwarded-for retry-after utf-8 utf-16 sha-1 sha-256 sha-512 iso-8601 base-64 and/or client/server read/write
true/false yes/no on/off input/output i/o ci/cd tcp/ip http/1.1 http/2 hh:mm
aes-128-cbc aes-256-cbc aes-128-gcm aes-256-gcm aes-gcm aes-cbc rsa-oaep rsa-pss hmac-sha256 sha-384 x-www-form-urlencoded
multi-part look-up look-ahead look-behind write-ahead time-to-live key-derivation
package.json tsconfig.json package-lock.json .env .gitignore .npmrc readme.md index.ts index.js index.tsx
node_modules pnpm-lock.yaml yarn.lock docker-compose.yml node.js next.js vue.js d3.js three.js e.g i.e
`;
const HYPHENATED_OK: ReadonlySet<string> = new Set(HYPHENATED_TEXT.split(/\s+/).filter(Boolean));

/** Well-known mixed letter-and-digit names. Lower-case. */
const KNOWN_ALNUM: ReadonlySet<string> = new Set(
  `oauth2 base64 base32 sha1 sha256 sha384 sha512 md5 utf8 utf16 es5 es6 es2015 es2020 es2022 http2 http3 ipv4 ipv6
  i18n l10n a11y k8s web3 ec2 s3 sqs sns uint8 uint16 uint32 int8 int16 int32 int64 float32 float64 vec2 vec3 vec4
  mp3 mp4 h264 x86 x64 arm64 win32 py3 python3 node18 node20 react18 vue3 angular2 oauth1 jwt2 tls1 ssl3 ecmascript2020
  2fa b2b b2c p2p 3d 2d 4k 5g`.split(/\s+/),
);

const SHORT_ALNUM = /^[A-Za-z]\d{1,2}$|^\d{1,2}[A-Za-z]$/;
const UNIT_NUMBER = /^\d{1,4}(?:st|nd|rd|th|x|xx|px|ms|s|m|h|d|kb|mb|gb|k)$/i;
const NUMBER_UNIT_COMPOUND =
  /^\d{1,4}-(?:byte|bit|digit|character|char|letter|hour|minute|second|day|week|month|year|row|item|line|word|point|column|part|level|way|step|page|time|key|value|field|space)s?$/i;
const PREFIXED =
  /^(?:non|pre|post|re|un|multi|cross|self|auto|semi|sub|inter|intra|co|anti|pseudo|sign|log|set|check|lower|upper|title|kebab|snake|camel|pascal|case|run|real|full|half|single|double|zero|well|so|all|any|long|short|high|low|top|read|write|time|hard|soft|deep|fast|slow|front|back)-[a-z]{3,12}$/;
const SUFFIXED =
  /^[a-z]{3,12}-(?:based|only|side|level|specific|aware|safe|free|like|wide|friendly|first|bound|ready|scoped|driven|encoded|decoded|readable|formatted|typed|named|sized|cased|sorted|separated|delimited|insensitive|sensitive|in|out|up|ahead|off|on|over|back|through|down|case|style|mode|key|way|line|time|check|only)$/;

function englishLooking(w: string): boolean {
  if (w.length > 20) return false;
  if (w.length >= 8 && !/[aeiouy]/.test(w)) return false;
  return !/[^aeiouy]{7,}/.test(w);
}

/** True for a lower-case English-looking word (letters only, at most 20), a capitalised one, a short acronym or a small number. */
export function isPlainToken(t: string): boolean {
  if (/^[a-z]+$/.test(t)) return englishLooking(t);
  if (/^[A-Z][a-z]+$/.test(t)) return englishLooking(t.toLowerCase());
  if (/^[A-Z]{1,5}s?$/.test(t)) return true;
  if (/^-?\d{1,6}$/.test(t) || /^\d{1,4}\.\d{1,3}$/.test(t)) return true;
  if (/^[a-z]+n't$/.test(t) && t.length <= 12) return true;
  return SHORT_ALNUM.test(t) || UNIT_NUMBER.test(t);
}

const FUNCTION_WORDS = new Set("for by of to in on the up a an and or with at as is not over per".split(" "));

/**
 * Plain words joined by hyphens or one slash: "later-work", "admin/applicant", "word-by-word", "waiting-for-review".
 * Two parts always qualify; three to five parts qualify only when one of them is a function word (for, by, of, to,
 * ...), so a package-like "left-pad-secure" does not.
 */
function plainCompound(t: string): boolean {
  const hyphen = t.split("-");
  const ok = hyphen.every((p) => p.length <= 14 && (isPlainToken(p) || p === "ID"));
  if (hyphen.length === 2) return ok;
  if (hyphen.length >= 3 && hyphen.length <= 5)
    return ok && hyphen.some((p) => FUNCTION_WORDS.has(p.toLowerCase()));
  const slash = t.split("/");
  return slash.length === 2 && slash.every((p) => /^[a-z]{2,14}$/.test(p) && isPlainToken(p));
}

/** Clock times and ranges: 09:00, 09:00-17:59. */
const TIME = /^\d{1,2}:\d{2}(?:-\d{1,2}:\d{2})?$/;

/** A bare file name with an extension that is not a top-level domain ("robots.txt"): it cannot be a host. */
const SAFE_FILE =
  /^[A-Za-z0-9_-]{1,30}\.(?:txt|xml|json|yaml|yml|toml|csv|png|svg|ico|html|css|js|ts|tsx|jsx|lock|log|ini|cfg|conf)$/;

function allowListed(t: string): boolean {
  const lower = t.toLowerCase();
  return (
    SAFE_FILE.test(t) ||
    TIME.test(t) ||
    /^[a-z]{2,12}_$/.test(t) ||
    plainCompound(t) ||
    HYPHENATED_OK.has(lower) ||
    KNOWN_ALNUM.has(lower) ||
    NUMBER_UNIT_COMPOUND.test(t) ||
    PREFIXED.test(lower) ||
    SUFFIXED.test(lower)
  );
}

/** A token that looks like a code identifier: lower/digit then capital (camelCase, PascalCase) or `x_y` (snake_case). */
export function isIdentifierLike(token: string): boolean {
  if (IDENTIFIER_STOP_LIST.has(token.toLowerCase())) return false;
  return /[a-z0-9][A-Z]/.test(token) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(token);
}

const IDENT = /[A-Za-z_$][\w$]*/g;
const DOTTED = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/g;

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

/** Name part of a symbol id `sym:src/a.ts#Class.method~2` or `src/a.ts#fn`. */
function idParts(id: string): { path: string; name: string } {
  const bare = id.startsWith("sym:") ? id.slice(4) : id;
  const hash = bare.indexOf("#");
  if (hash < 0) return { path: "", name: bare };
  return { path: bare.slice(0, hash), name: bare.slice(hash + 1).replace(/~\d+$/, "") };
}

/**
 * Everything a description may mention beyond plain words: the symbol's names. Not the string literals or comments of
 * the body (an attacker controls those), and not dotted chains from the body (only dotted names the index itself
 * produced: id, callees, signature, return type, file names).
 */
export function groundingNames(sheet: FactSheet): Set<string> {
  const names = new Set<string>();
  const add = (s: string) => {
    if (s !== "") names.add(s);
  };
  const addIdents = (s: string, dotted: boolean) => {
    for (const m of s.match(IDENT) ?? []) add(m);
    if (dotted) for (const m of s.match(DOTTED) ?? []) add(m);
  };

  const { path: idPath, name } = idParts(sheet.id);
  add(name);
  for (const part of name.split(".")) add(part);
  addIdents(name, false);
  for (const p of [sheet.path, idPath]) {
    add(p);
    for (const seg of p.split("/")) {
      add(seg);
      const dot = seg.indexOf(".", 1);
      if (dot > 0) add(seg.slice(0, dot));
      const last = seg.lastIndexOf(".");
      if (last > 0) add(seg.slice(0, last));
    }
  }
  addIdents(sheet.signature, true);
  addIdents(sheet.returnType ?? "", true);
  for (const c of sheet.callees) {
    add(c);
    for (const part of c.split(".")) add(part);
  }
  addIdents(sheet.doc ?? "", false);
  addIdents(stripLiteralsAndComments(sheet.body), false);
  // Enum-like string values ("NOT_FOUND", "retry_later", "FORBIDDEN") are the vocabulary of the function, and a single
  // UPPER_SNAKE or snake_case word cannot be a host, a path or a package name.
  for (const m of sheet.body.matchAll(
    /["'`]([A-Za-z][A-Za-z0-9]{0,20}(?:_[A-Za-z0-9]{1,20}){1,5}|[A-Z]{6,30})["'`]/g,
  ))
    add(m[1] as string);
  return names;
}

/** Back-compat name: the set of grounded names. */
export function factSheetTokens(sheet: FactSheet): Set<string> {
  return groundingNames(sheet);
}

/** True when `token` needs no grounding or is grounded. */
export function isGrounded(token: string, names: ReadonlySet<string>): boolean {
  return (
    isPlainToken(token) ||
    IDENTIFIER_STOP_LIST.has(token.toLowerCase()) ||
    names.has(token) ||
    allowListed(token)
  );
}

/** Tokens of `text` that are neither plain, nor on a list, nor among `names` (deduplicated, original spelling). */
export function ungroundedTokens(text: string, names: ReadonlySet<string>): string[] {
  const bad: string[] = [];
  for (const t of tokenize(text)) if (!isGrounded(t, names) && !bad.includes(t)) bad.push(t);
  return bad;
}

/** Ungrounded tokens in `behavior` (deduplicated). Kept under its old name. */
export function unknownIdentifiers(behavior: string, sheet: FactSheet): string[] {
  return ungroundedTokens(behavior, groundingNames(sheet));
}

/** Words of a camelCase / PascalCase / snake_case identifier: `parseHTMLString_v2` -> parse, HTML, String, v2. */
export function splitIdentifierWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_$]+/)
    .filter(Boolean);
}

/** Detail text for ungrounded tokens: at most five, opaque ones shortened. */
export function describeUngrounded(tokens: readonly string[]): string {
  return `not in the fact sheet: ${tokens.slice(0, 5).map(echoToken).join(", ")}`;
}

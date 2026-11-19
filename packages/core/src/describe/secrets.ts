// Secret filter (spec section 8 / issue #22). Pure functions. Matched text is NEVER returned or logged: callers only
// ever see rule names. Every regex is linear: repetition is bounded or runs over a character class that the next
// element of the pattern cannot also match, so no input makes the scan super-linear.

import { stripInvisible } from "./text.js";
import { isWord } from "./wordlist.js";

export interface SecretRule {
  name: string;
  /** Global. A named group `v` marks the part to redact; without it the whole match is redacted. */
  re: RegExp;
  /**
   * Extra test on the named groups of a match; a rule with `accept` only fires when it returns true. `redact` is true
   * when the redactor runs (source code on its way to a fact sheet) and false when a model's description is scanned:
   * the redactor leaves alone what is common in ordinary code (commit SHAs, i18n labels, routes, SRI hashes).
   */
  accept?: (groups: Record<string, string>, redact: boolean) => boolean;
  /** Anchored on a vendor prefix or fixed shape, so it is also run on text with spaces and hyphens between alphanumerics removed. */
  collapsible?: boolean;
  /** Custom replacement used by the redactor instead of redacting the `v` group. */
  replace?: (match: string, groups: Record<string, string>) => string;
}

const B64 = "A-Za-z0-9+/_-";
const MARKER = "<redacted>";

/** Words that make a name a credential name on their own. */
const CREDENTIAL_WORDS = new Set(
  "password passwd pwd pass secret token credential credentials apikey passphrase".split(" "),
);
/** `key` makes a name a credential name only next to one of these (`apiKey`, `SECRET_KEY`, `signingKey`; not `sortKey`). */
const KEY_COMPANIONS = new Set(
  "api secret access private signing sign auth encryption master license".split(" "),
);
/** A last word that says the value describes the credential and is not one (`tokenType`, `passwordLabel`). */
const DESCRIPTOR_WORDS = new Set(
  "type name kind label url path header prefix endpoint expiry expires ttl count length pattern regex dir file field placeholder hint message title error mode status".split(
    " ",
  ),
);
/** Names for which a value with spaces (a passphrase) is still a credential. */
const STRONG_WORDS = new Set("secret token password passwd pwd passphrase credential credentials".split(" "));

/** Lower-case words of a name: `dbPass`, `DB_PASSWORD`, `api-key` and `a.b.token` give their parts. */
export function nameParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_.$-]+/)
    .filter(Boolean);
}

/** True when `name` (an identifier or a quoted key) names a credential: password, secret, token, api key, ... */
export function isCredentialName(name: string): boolean {
  const parts = nameParts(name);
  if (parts.length === 0) return false;
  const last = parts[parts.length - 1] as string;
  if (parts.length > 1 && DESCRIPTOR_WORDS.has(last)) return false;
  if (parts.some((p) => CREDENTIAL_WORDS.has(p))) return true;
  return parts.includes("key") && parts.some((p) => KEY_COMPANIONS.has(p));
}

function hasStrongWord(name: string): boolean {
  return nameParts(name).some((p) => STRONG_WORDS.has(p));
}

/** Option values that are keywords of an API, not secrets (`credentials: "same-origin"`). */
const NON_SECRET_VALUES = new Set([
  "same-origin",
  "include",
  "omit",
  "none",
  "true",
  "false",
  "null",
  "undefined",
]);

/**
 * Text right before a git object id: `commit `, `sha1: `, `rev=` or `/commit/`. Nothing else counts (not `ref`, `hash`,
 * `digest`, `checksum`, `@` or `#`: a secret can sit behind any of those).
 */
const COMMIT_CONTEXT = /(?:\b(?:commit|sha|sha1|rev)\b\s{0,3}[:=]?\s{0,3}["'`]?|\/commit\/)$/i;
/** Context that makes a hex run after `sha` a signature or HMAC value, not a commit id. */
const SIGNATURE_CONTEXT = /signature|authorization|hmac|bearer|header|digest|checksum/i;

/** A git object id the redactor leaves alone: exactly 40 or 64 hex digits right after a commit word. */
function isCommitId(hex: string, ctx: string): boolean {
  return (hex.length === 40 || hex.length === 64) && COMMIT_CONTEXT.test(ctx) && !SIGNATURE_CONTEXT.test(ctx);
}

/** A capitalised phrase of letters and spaces: "Enter your password". */
function looksLikeLabel(v: string): boolean {
  return /\s/.test(v) && /^\p{Lu}[\p{L}' ,.!?-]*$/u.test(v) && v.trim().split(/\s+/).length >= 2;
}

/** Words of a sentence written for a person. `is` is left out on purpose: "Winter Is Coming" is a passphrase. */
const SENTENCE_WORDS = new Set(
  "your you the a an to enter type please choose confirm for of must at least".split(" "),
);

/** The value reads as a sentence for a person: a label phrase of 3+ words that holds a function word. */
function readsAsSentence(v: string): boolean {
  return (
    looksLikeLabel(v) &&
    v.trim().split(/\s+/).length >= 3 &&
    v
      .toLowerCase()
      .split(/\s+/)
      .some((w) => SENTENCE_WORDS.has(w))
  );
}

/**
 * A prompt for the user, not a secret: the whole value is an instruction to type a credential and ends on the credential
 * noun ("Enter your password", "Please confirm the new passphrase here:"). Openers other than enter, type, confirm and
 * re-enter ("Your ...", "Set ...", "New ...", "Choose ...") do not count: "Your Password Is Swordfish" is a secret.
 */
function isPlaceholderPrompt(v: string): boolean {
  return /^(?:please\s+)?(?:enter|type|confirm|re-?enter)\s+(?:(?:your|the|a|an)\s+)?(?:(?:new|current|old|access|api)\s+)?(?:password|passphrase|passcode|token|secret|key|pin|code|credentials?)(?:\s+here)?[.:]?$/i.test(
    v.trim(),
  );
}

/** Names whose last word says the value is text shown to a person (`passwordText`, `tokenCaption`). */
const LABEL_NAME_WORDS = new Set(
  "label placeholder hint text message title caption prompt description tooltip helper".split(" "),
);
function isLabelName(name: string): boolean {
  const parts = nameParts(name);
  return parts.length > 1 && LABEL_NAME_WORDS.has(parts[parts.length - 1] as string);
}

/** Words that make a call a login: `login("admin", "pw")`, `signIn(...)`, `basicAuth(...)`. */
const LOGIN_WORDS = new Set("login logon signin sign authenticate auth basic credentials connect".split(" "));

/** Values that are message keys, not secrets: `auth.login_title`, `errors:password`. */
function looksLikeMessageKey(v: string): boolean {
  return /^[a-z]+(?:[._:][a-z_]+)+$/.test(v);
}

export const SECRET_RULES: readonly SecretRule[] = [
  {
    name: "aws-access-key",
    re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
    collapsible: true,
  },
  {
    name: "aws-secret-key",
    re: /aws[_-]?secret[_-]?(?:access[_-]?)?key["']?\s{0,20}[:=]\s{0,20}["']?(?<v>[A-Za-z0-9/+=]{40})/gi,
    collapsible: true,
  },
  {
    name: "github-token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g,
    collapsible: true,
  },
  { name: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{16,}/g, collapsible: true },
  {
    name: "slack-token",
    re: /\bxox[abeposr]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}/g,
    collapsible: true,
  },
  {
    name: "slack-webhook",
    re: /hooks\.slack\.com\/(?:services|workflows)\/[A-Za-z0-9/_-]{12,}/g,
    collapsible: true,
  },
  {
    name: "stripe-key",
    re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|\bwhsec_[A-Za-z0-9]{16,}/g,
    collapsible: true,
  },
  { name: "openai-anthropic-key", re: /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}/g, collapsible: true },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, collapsible: true },
  { name: "google-oauth-secret", re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g, collapsible: true },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g, collapsible: true },
  { name: "huggingface-token", re: /\bhf_[A-Za-z0-9]{30,}/g, collapsible: true },
  {
    name: "sendgrid-key",
    re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    collapsible: true,
  },
  { name: "twilio-sid", re: /\b(?:AC|SK)[0-9a-f]{32}\b/g, collapsible: true },
  { name: "mailgun-key", re: /\bkey-[0-9a-f]{32}\b/g, collapsible: true },
  { name: "shopify-token", re: /\bshp(?:at|ca|pa|ss)_[0-9a-fA-F]{32}/g, collapsible: true },
  { name: "vercel-token", re: /\bvercel_[A-Za-z0-9]{16,}/g, collapsible: true },
  { name: "digitalocean-token", re: /\bdo[por]_v1_[0-9a-f]{64}/g, collapsible: true },
  { name: "square-token", re: /\bEAAA[A-Za-z0-9_-]{40,}/g, collapsible: true },
  {
    name: "discord-token",
    re: /\b[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}/g,
    collapsible: true,
  },
  { name: "azure-sas", re: /\bsig=[A-Za-z0-9%+/]{30,}/g, collapsible: true },
  { name: "azure-storage-key", re: /AccountKey=(?<v>[A-Za-z0-9+/=]{40,})/g, collapsible: true },
  { name: "base64-der-key", re: /\bMII[A-Za-z0-9+/]{40,}/g, collapsible: true },
  {
    // A run of 32+ hex digits. When the redactor runs, exactly 40 or 64 digits right after `commit`, `sha`, `rev` or
    // `/commit/` are a git object id and is left alone: they fill ordinary changelogs and lock files.
    name: "hex-secret",
    re: /(?<!\w)(?<=(?<ctx>.{0,40}))(?<h>[0-9a-fA-F]{32,})(?!\w)/g,
    accept: (g, redact) => !(redact && isCommitId(g.h ?? "", g.ctx ?? "")),
    collapsible: true,
  },
  {
    name: "private-key",
    // The header, plus the key body through the END line when present (the body has no recognisable shape).
    re: /-----BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]{0,6000}?-----END (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----)?/g,
    collapsible: true,
  },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g, collapsible: true },
  {
    name: "connection-string",
    // A URL with a password in its user-info part (any scheme, user may be empty); whatever precedes the secret,
    // including a redaction marker, is part of the value.
    re: /\b[a-z][a-z0-9+.-]{0,15}:\/\/[^\s:@/'"`]{0,100}:(?<v>[^\s@/'"`]{1,200})@/gi,
    accept: (g) => g.v !== MARKER,
  },
  {
    name: "userinfo-without-scheme",
    re: /\b[A-Za-z0-9._-]{1,40}:(?<v>[^\s:@/'"`<>]{3,60})@[A-Za-z0-9][A-Za-z0-9.-]{1,60}/g,
  },
  { name: "bearer-token", re: /\bBearer\s{1,5}(?<v>[A-Za-z0-9._~+/=-]{20,})/g },
  {
    // `name = "value"` / `name: "value"` / `"name": "value"` where the name is a credential name; the value is any
    // string literal of four characters or more, in any letter case. Interpolated templates are left alone.
    name: "generic-credential",
    // Go: the short declaration `:=` and a declaration with a type between the name and `=` are assignments too;
    // `var` and `const` are never the name, so the match starts at the variable.
    re: /(?<![\w$.-])(?!(?:var|const)\s)(?<name>[A-Za-z_$][\w$.-]{0,60})["']?(?:\s{0,20}(?::=|[:=])|[ \t]{1,20}[*[\]A-Za-z_][\w.*[\]]{0,40}[ \t]{0,20}=)\s{0,20}(?<q>["'`])(?<v>[^"'`\r\n]{4,200})/g,
    accept: (g, redact) => {
      const v = g.v ?? "";
      if (v === MARKER || !isCredentialName(g.name ?? "")) return false;
      if (g.q === "`" && v.includes("${")) return false;
      if (looksLikeMessageKey(v) || NON_SECRET_VALUES.has(v)) return false;
      // A text for a person ("Enter your password") is not a secret, but only when the name says so or the value reads as
      // a sentence; a capitalised phrase behind a plain credential name stays redacted (`password = "Correct Horse Battery"`).
      // A strong credential name (password, token, secret, ...) is redacted whatever the value reads like, except a
      // placeholder prompt; the sentence exemption holds only for other names.
      const name = g.name ?? "";
      if (
        redact &&
        ((isLabelName(name) && looksLikeLabel(v)) ||
          (readsAsSentence(v) && (!hasStrongWord(name) || isPlaceholderPrompt(v))))
      )
        return false;
      // `key: "Please enter your password"` is a label; a space in the value only counts for strong credential names.
      return !/\s/.test(v) || hasStrongWord(g.name ?? "");
    },
  },
  {
    // A credential name assigned two or more string literals joined with plus: every literal is part of the secret.
    name: "concatenated-credential",
    re: /(?<![\w$.-])(?<head>(?<name>[A-Za-z_$][\w$.-]{0,60})["']?\s{0,20}[:=]\s{0,20})(?:"[^"\r\n]{0,200}"|'[^'\r\n]{0,200}')(?:\s{0,5}\+\s{0,5}(?:"[^"\r\n]{0,200}"|'[^'\r\n]{0,200}')){1,4}/g,
    accept: (g) => isCredentialName(g.name ?? ""),
    replace: (_m, g) => `${g.head}"${MARKER}"`,
  },
  {
    // Unquoted values: shell style (NAME=value in capitals) and YAML style (name: value with a digit in the value).
    name: "unquoted-credential",
    re: /(?<![\w$.-])(?<name>[A-Za-z_$][\w$.-]{0,60})(?<sep>=|:[ \t]{1,3})(?<v>[^\s"'`;,(){}[\]=]{4,200})/g,
    accept: (g) => {
      const v = g.v ?? "";
      const name = g.name ?? "";
      if (v === MARKER || /^(?:process\.|import\.meta|env\.|this\.|\$|@|\/)/.test(v)) return false;
      if (!isCredentialName(name)) return false;
      if (/^[A-Z][A-Z0-9_]*$/.test(name) && g.sep === "=") return true; // shell style: API_KEY=value
      // Lower-case or camelCase names: a random-looking value (it holds a digit and a letter, no call or member chain).
      return /\d/.test(v) && /[A-Za-z]/.test(v) && !/[A-Za-z]\.[A-Za-z]/.test(v);
    },
  },
  {
    // An unquoted upper-case environment assignment (`export NAME=<value>`) whose value looks random
    // (16+ characters with a letter and a digit, no path, URL or reference).
    name: "env-assignment",
    re: /(?<![\w$.-])(?<name>[A-Z][A-Z0-9_]{2,60})=(?<v>[^\s"'`;,(){}[\]=<>]{16,200})/g,
    accept: (g) => {
      const v = g.v ?? "";
      if (v === MARKER || /^(?:process\.|import\.meta|env\.|this\.|\$|@|\/|\.|https?:|file:|%|-)/i.test(v))
        return false;
      return (
        /\d/.test(v) &&
        /[A-Za-z]/.test(v) &&
        !/[A-Za-z]\.[A-Za-z]/.test(v) &&
        !/^[\w-]+(?:\/[\w.-]+){2,}$/.test(v)
      );
    },
  },
  {
    // A secret assembled from an array of string literals and joined with an empty string. Redacted when the joined text is a
    // credential by itself or sits behind a credential name.
    name: "joined-literals",
    re: /(?:(?<![\w$.-])(?<name>[A-Za-z_$][\w$.-]{0,60})["']?\s{0,20}[:=]\s{0,20})?\[(?<items>(?:\s{0,5}(?:"[^"\r\n]{0,80}"|'[^'\r\n]{0,80}')\s{0,5},){1,8}\s{0,5}(?:"[^"\r\n]{0,80}"|'[^'\r\n]{0,80}'))\s{0,5},?\s{0,5}\]\s{0,5}\.\s{0,5}join\(\s{0,5}(?:""|''|``)?\s{0,5}\)/g,
    accept: (g) => {
      const joined = joinedLiterals(g.items ?? "");
      if (joined.length < 4) return false;
      if ((g.name ?? "") !== "" && isCredentialName(g.name ?? "")) return true;
      return rulesHitting(joined, SECRET_RULES, true).length > 0 || isHighEntropyToken(joined);
    },
    replace: (_m, g) => `${(g.name ?? "") !== "" ? `${g.name} = ` : ""}"${MARKER}"`,
  },
  {
    // A literal passed positionally to a call whose name says it takes a credential (a login call with a user and a
    // password, a set-password call). The last literal is the secret.
    name: "positional-credential",
    re: /(?<![\w$])(?<name>[A-Za-z_$][\w$]{0,40})\s{0,3}\(\s{0,3}(?<pre>(?:(?:"[^"\r\n]{0,100}"|'[^'\r\n]{0,100}')\s{0,3},\s{0,3}){0,3})(?<q>["'])(?<v>[^"'\r\n]{4,200})["']\s{0,3}[,)]/g,
    accept: (g) => {
      const v = g.v ?? "";
      const name = g.name ?? "";
      if (v === MARKER || NON_SECRET_VALUES.has(v) || /^[/.#]/.test(v)) return false;
      const earlier = ((g.pre ?? "").match(/,/g) ?? []).length;
      if (earlier >= 1) {
        const parts = nameParts(name);
        if (!parts.some((p) => LOGIN_WORDS.has(p)) || /\s/.test(v)) return false;
        // `connect("db", "example.com")`: a host or port is not a secret. Only `connect` takes a host after a first
        // argument; for login-style calls the second argument is the password, so `pass.word` stays redacted.
        const connectOnly =
          parts.includes("connect") && !parts.some((p) => p !== "connect" && LOGIN_WORDS.has(p));
        if (connectOnly && (/^localhost$/i.test(v) || /^(?:[a-z0-9-]+\.)+[a-z]{2,10}$/i.test(v)))
          return false;
        if (/^\d{1,5}$/.test(v)) return false;
        // an HTTP method is not a secret, and a plain lower-case word after one is a path or resource ("users")
        if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(v)) return false;
        if (
          /^[a-z]+$/.test(v) &&
          /(?:^|,)\s*["'](?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["']\s*,\s*$/.test(g.pre ?? "")
        )
          return false;
        // message keys (`auth.login_title`) have three parts or an underscore; a two-part word is a password
        if (looksLikeMessageKey(v) && (/_/.test(v) || v.split(/[._:]/).length > 2)) return false;
        return true;
      }
      if (looksLikeMessageKey(v)) return false;
      return isCredentialName(name) && /\d/.test(v) && /[A-Za-z]/.test(v) && !/\s/.test(v);
    },
  },
  {
    // A credential given as a command-line argument: a password, token or key flag with its value, or curl's `-u` pair.
    name: "cli-credential",
    re: /(?<![\w-])(?:--?(?:password|passwd|pwd|pass|token|secret|api-key|apikey|auth-token|access-token|client-secret|private-key|passphrase)(?:=|\s{1,3})["']?(?<v>[^\s"'`;|&<>]{4,200})|(?<=\bcurl\s[^\n|;&]{0,80}?)-u\s{1,3}["']?(?<u>[^\s:"'`$]{1,60}:[^\s"'`$]{4,100})|(?<=\bmysql(?:dump|admin)?\s[^\n|;&]{0,80}?)-p(?<m>[^\s"'`$;|&<>-][^\s"'`;|&<>]{3,100}))/g,
    accept: (g) => {
      const v = g.v ?? g.u ?? g.m ?? "";
      return v !== MARKER && !/^[-$%{<@(]|^env:/i.test(v) && (g.m === undefined || !/^\d+$/.test(v));
    },
    replace: (m, g) => {
      const v = g.v ?? g.u ?? g.m ?? "";
      const at = m.lastIndexOf(v);
      return at < 0 ? MARKER : m.slice(0, at) + MARKER + m.slice(at + v.length);
    },
  },
  { name: "age-secret-key", re: /\bAGE-SECRET-KEY-1[A-Z0-9]{20,}/g, collapsible: true },
  {
    name: "basic-auth-header",
    re: /\bBasic\s{1,5}(?<v>[A-Za-z0-9+/]{8,}={0,2})/g,
    accept: (g) => /\d|=|[A-Z].*[A-Z]/.test(g.v ?? ""),
  },
  {
    name: "cookie-session",
    re: /(?<![\w-])(?<cn>[A-Za-z_.-]{0,20}(?:session|sess|sid|auth|jwt|token)[A-Za-z_.-]{0,10})=(?<v>[A-Za-z0-9%._~+/=<>-]{16,})/gi,
    accept: (g) => g.v !== MARKER,
  },
  { name: "pypi-token", re: /\bpypi-[A-Za-z0-9_-]{40,}/g, collapsible: true },
  { name: "linear-key", re: /\blin_(?:api|oauth)_[A-Za-z0-9]{30,}/g, collapsible: true },
  { name: "notion-token", re: /\b(?:secret_|ntn_)[A-Za-z0-9]{36,}/g, collapsible: true },
  { name: "telegram-bot-token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, collapsible: true },
  {
    name: "discord-webhook",
    re: /discord(?:app)?\.com\/api\/webhooks\/\d{6,}\/[A-Za-z0-9_-]{20,}/g,
    collapsible: true,
  },
  { name: "sentry-dsn", re: /:\/\/(?<v>[0-9a-f]{20,})@/g },
  { name: "google-access-token", re: /\bya29\.[A-Za-z0-9_-]{20,}/g, collapsible: true },
  { name: "stripe-publishable", re: /\bpk_(?:live|test)_[A-Za-z0-9]{10,}/g, collapsible: true },
  { name: "airtable-token", re: /\bpat[A-Za-z0-9]{14}\.[0-9a-f]{40,}/g, collapsible: true },
  { name: "rubygems-token", re: /\brubygems_[0-9a-f]{40,}/g, collapsible: true },
  { name: "square-access", re: /\bsq0(?:atp|csp)-[A-Za-z0-9_-]{20,}/g, collapsible: true },
];

/** The text of the string literals in `items`, joined: `"sk_", 'live_'` gives `sk_live_`. */
function joinedLiterals(items: string): string {
  let out = "";
  for (const m of items.matchAll(/"([^"\r\n]{0,80})"|'([^'\r\n]{0,80})'/g)) out += m[1] ?? m[2] ?? "";
  return out;
}

/** `sha384-oqVuAfXRKap7...`: a Subresource Integrity hash is a digest, not a secret. */
function isIntegrityHash(tok: string): boolean {
  return /^sha(?:256|384|512)-[A-Za-z0-9+/]{40,}={0,2}$/.test(tok);
}

/** `/api/v1/orgs/:orgId/invitations`: every segment is a version, a parameter or words of the dictionary. */
function isRoute(tok: string): boolean {
  if (!tok.includes("/")) return false;
  const segs = tok.split("/").filter((x) => x !== "");
  if (segs.length < 2) return false;
  return segs.every(
    (seg) =>
      /^(?:v\d{1,2}|:[A-Za-z_]\w*|\{[A-Za-z_]\w*\}|\d{1,4})$/.test(seg) ||
      (/^[a-z][a-z-]*[a-z]$|^[a-z]$/.test(seg) && seg.split("-").every((part) => isWord(part))),
  );
}

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
export function isHighEntropyToken(tok: string, redact = false): boolean {
  if (redact) {
    if (isIntegrityHash(tok) || isRoute(tok)) return false;
    // a git object id inside a URL or lock-file reference: `commit/<sha>`, `#<sha>`
    const rest = tok.replace(
      /(?:commit\/|\b(?:sha1?|rev)=)(?:[0-9a-f]{40}|[0-9a-f]{64})(?![0-9A-Za-z])/gi,
      "",
    );
    if (rest !== tok) return isHighEntropyToken(rest, false);
  }
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

/** Hyphens between two alphanumerics removed ("AKIA-IOSF-ODNN" becomes "AKIAIOSFODNN"); spaces stay, so word boundaries survive. */
function collapseHyphens(text: string): string {
  // A UUID is 32 hex digits once its hyphens go; it is an identifier, not a key.
  const masked = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "uuid");
  return masked.replace(/(?<=[A-Za-z0-9])-+(?=[A-Za-z0-9])/g, "");
}

const WINDOW_TOKEN = /^[A-Za-z0-9_+/=.%]+$/;
const KEYISH = /\d|_|[A-Z]{2}/;
const MAX_WINDOW_TOKENS = 6;

/**
 * Runs of two to six adjacent tokens joined without their spaces, for keys broken across words or fields. Only
 * windows that look key-like (a digit, an underscore or two capitals) are returned, so ordinary prose yields few.
 */
function windows(text: string): string[] {
  const tokens = text.split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let joined = "";
    for (let k = 0; k < MAX_WINDOW_TOKENS && i + k < tokens.length; k++) {
      const t = tokens[i + k] as string;
      if (t.length > 40 || !WINDOW_TOKEN.test(t)) break;
      joined += t;
      if (k >= 1 && joined.length >= 16 && joined.length <= 140 && KEYISH.test(joined)) out.push(joined);
    }
  }
  return out;
}

function groupsOf(m: RegExpExecArray): Record<string, string> {
  return (m.groups ?? {}) as Record<string, string>;
}

function rulesHitting(text: string, rules: readonly SecretRule[], redact = false): string[] {
  const hits: string[] = [];
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null = rule.re.exec(text);
    while (m !== null) {
      if (rule.accept === undefined || rule.accept(groupsOf(m), redact)) {
        hits.push(rule.name);
        break;
      }
      if (m[0] === "") rule.re.lastIndex++;
      m = rule.re.exec(text);
    }
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
const COLLAPSIBLE_RULES = SECRET_RULES.filter((r) => r.collapsible === true);

/**
 * Names of the secret rules that match `text`, in rule order, without duplicates. Never returns matched text.
 * Zero-width and other invisible characters are removed and the text is NFKC-normalised first, so a key split by a
 * zero-width space or written in fullwidth letters is still found. A second pass removes hyphens between alphanumerics and
 * joins runs of adjacent tokens, then runs the prefix-anchored rules again, so "AKIA-IOSF-ODNN" or a key broken across words is found
 * (reported as `split:<rule>`). Base64 tokens are also decoded and scanned (reported as `base64:<rule>`).
 */
export function scanSecrets(text: string): string[] {
  const norm = normalizeForScan(text);
  const hits = rulesHitting(norm, SECRET_RULES);
  if ((norm.match(ENTROPY_TOKEN) ?? []).some((t) => isHighEntropyToken(t))) hits.push("high-entropy");
  const collapsed = collapseHyphens(norm);
  const splitHits: string[] = [];
  if (collapsed !== norm) splitHits.push(...rulesHitting(collapsed, COLLAPSIBLE_RULES));
  for (const w of windows(collapsed)) splitHits.push(...rulesHitting(w, COLLAPSIBLE_RULES));
  for (const name of splitHits)
    if (!hits.includes(name) && !hits.includes(`split:${name}`)) hits.push(`split:${name}`);
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

function redactWith(text: string, rules: readonly SecretRule[]): string {
  let out = text;
  for (const rule of rules) {
    out = out.replace(rule.re, (...args: unknown[]) => {
      const match = args[0] as string;
      const last = args[args.length - 1];
      const groups = typeof last === "object" && last !== null ? (last as Record<string, string>) : undefined;
      if (rule.accept !== undefined && !rule.accept(groups ?? {}, true)) return match;
      if (rule.replace !== undefined) return rule.replace(match, groups ?? {});
      const v = groups?.v;
      if (v === undefined) return MARKER;
      const at = match.lastIndexOf(v);
      return at < 0 ? MARKER : match.slice(0, at) + MARKER + match.slice(at + v.length);
    });
    rule.re.lastIndex = 0;
  }
  return out;
}

/**
 * Replaces every secret in source text with `<redacted>` before the fact sheet is sent anywhere. Code that holds
 * no secret is returned unchanged (invisible format characters are dropped, since they can hide a key). Generic
 * `name = "value"` credentials and connection strings keep their name and redact only the value. The value a rule
 * redacts includes any `<redacted>` text already in it, so a marker placed in front of a secret hides nothing, and
 * redacting twice gives the same text as redacting once.
 */
export function redactForFactSheet(text: string): string {
  let out = stripInvisible(text);
  const folded = out.normalize("NFKC");
  // Fullwidth or ligature spellings of a key: adopt the folded text only when it reveals a hit the raw text hides.
  if (
    folded !== out &&
    rulesHitting(folded, SECRET_RULES, true).length > rulesHitting(out, SECRET_RULES, true).length
  ) {
    out = folded;
  }
  out = redactWith(out, SECRET_RULES);
  // Vendor keys broken by hyphens ("AKIA-IOSF-ODNN-..."): replace the whole hyphenated run.
  out = out.replace(/\b[A-Za-z0-9]{1,12}(?:-[A-Za-z0-9]{1,12}){2,12}\b/g, (tok) => {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tok)) return tok;
    return rulesHitting(tok.replace(/-/g, ""), COLLAPSIBLE_RULES, true).length > 0 ? MARKER : tok;
  });
  out = out.replace(ENTROPY_TOKEN, (tok) => (isHighEntropyToken(tok, true) ? MARKER : tok));
  out = out.replace(B64_TOKEN, (tok) => {
    const decoded = decodePrintable(tok);
    return decoded !== null && rulesHitting(decoded, SECRET_RULES, true).length > 0 ? MARKER : tok;
  });
  return out;
}

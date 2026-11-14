// Identifier check (spec section 8 check 3): every camelCase / PascalCase / snake_case token in `behavior`
// must appear in the fact sheet, unless it is a well-known term from the stop-list.

import type { FactSheet } from "../types.js";

/**
 * About 200 common English words and well-known product or platform terms. Plain words never look like
 * identifiers; they are listed for completeness (and so a future looser identifier rule stays safe). The terms that
 * matter are the camelCase / PascalCase / snake_case-looking ones. Compared case-insensitively.
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
`;

export const IDENTIFIER_STOP_LIST: ReadonlySet<string> = new Set(
  STOP_WORDS.split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase()),
);

/** A token that looks like a code identifier: lower/digit then capital (camelCase, PascalCase) or `x_y` (snake_case). */
export function isIdentifierLike(token: string): boolean {
  if (IDENTIFIER_STOP_LIST.has(token.toLowerCase())) return false;
  return /[a-z0-9][A-Z]/.test(token) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(token);
}

/** Everything a description may legitimately mention: identifier-like tokens from the whole fact sheet. */
export function factSheetTokens(sheet: FactSheet): Set<string> {
  const text = [
    sheet.id,
    sheet.path,
    sheet.kind,
    sheet.signature,
    sheet.doc ?? "",
    sheet.callees.join(" "),
    sheet.returnType ?? "",
    sheet.body,
  ].join("\n");
  return new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []);
}

/** Identifier-like tokens in `behavior` that are neither in the fact sheet nor on the stop-list (deduplicated). */
export function unknownIdentifiers(behavior: string, sheet: FactSheet): string[] {
  const known = factSheetTokens(sheet);
  const bad: string[] = [];
  for (const w of behavior.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    if (!isIdentifierLike(w) || known.has(w) || bad.includes(w)) continue;
    bad.push(w);
  }
  return bad;
}

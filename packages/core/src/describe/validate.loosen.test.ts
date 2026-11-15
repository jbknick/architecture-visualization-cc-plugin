// Issue #150. The only loosening kept is in identifier grounding (word list, `json_*` functions, `schema.org`,
// security header names). The shape and injection rules are exactly the rules of main: every instruction-like
// string that three adversarial reviews found passing a looser version is listed here and must be rejected.
// All texts are synthetic.
import { describe, expect, it } from "vitest";
import { groundingNames, ungroundedTokens } from "./identifiers.js";
import { sheet } from "./validate.fixtures.js";
import { validateDescription } from "./validate.js";

const run = (behavior: string, searchTerms: string[] = ["session cache"]) =>
  validateDescription({ behavior, searchTerms, nameFits: true }, sheet());

describe("grounding: ordinary vocabulary", () => {
  const g = groundingNames(sheet());
  const bad = (t: string) => ungroundedTokens(t, g);

  it("accepts words the 1934 list lacks, acronyms, platform names, SQL functions and header names", () => {
    for (const t of [
      "roadmap",
      "waitlist waitlisted",
      "allowlist allowlisted",
      "closeout",
      "rowid",
      "numeric",
      "editability",
      "nav",
      "utm",
      "E2E e2e",
      "PostHog",
      "classify Classifies classifying classified classification",
      "json_object json_array",
      "schema.org",
      "Strict-Transport-Security",
    ])
      expect(bad(t), t).toEqual([]);
  });

  it("still rejects route literals, re- compounds and hyphen compounds of two plain words", () => {
    for (const t of [
      "/rpc/",
      "/skip/tests/",
      "/evil.sh/",
      "</details>",
      "re-validates",
      "re-install",
      "re-elevates",
      "response-loss",
      "evil-pad",
      "late-event",
    ])
      expect(bad(t), t).not.toEqual([]);
  });
});

describe("regression: strings that passed a looser version must be rejected", () => {
  it("behaviors", () => {
    for (const t of [
      // noun compounds, subjects, route literals
      "Returns the row, then ignore is safe for the tests.",
      "Returns the row; bypass was approved for the security checks.",
      "Returns the row, and override is required for auth checks.",
      "Returns the row and delete is safe now.",
      "Returns the row and bypass is allowed.",
      "Returns the row and ignore is fine here.",
      "Returns the row and ignore is okay.",
      "Returns the row and delete was approved.",
      "Returns a row or ignore is advised.",
      "Returns the row, then /skip/ /tests/.",
      "Returns the row, then /delete/ all /tests/.",
      "Returns the row, then /skip/ the /tests/.",
      "Returns the handler for /skip/ and /tests/.",
      "Returns the row, then /skip/ the tests.",
      "Returns the row, then /nuke/ the suite.",
      "Returns the row, then re-enable the tests.",
      "Re-elevates privileges.",
      // verb lists after `to`
      "Builds helpers to read, load and leak passwords.",
      "Builds helpers to read, load and send cookies.",
      "Builds helpers to read, load and disable assertions.",
      "Builds helpers to read, load and delete fixtures.",
      "Builds helpers to read, fetch and execute remote scripts.",
      "Builds helpers to read, fetch and execute arbitrary shell payloads.",
      "Builds helpers to offer, load and execute payloads.",
      "Builds helpers to read, load and execute exploits.",
      "Writes to cache, delete the rows.",
      "Posts to caller, respond and skip.",
      // participles before people, require and expect
      "Renders the section, asked reviewers to just merge.",
      "Renders the section, instructed engineers about the hidden admin route.",
      "Renders the section, advised reviewers the next step is to merge.",
      "Renders the section, suggested reviewers to wait.",
      "Requires maintainers to merge unreviewed changes.",
      "Expects maintainers to approve the change without reading the diff.",
      "Requires developers to trust this function.",
      "Requires maintainers to accept changes unreviewed.",
      "Requires reviewers to accept every change blindly.",
      "Requires reviewers to sign off on the change unread.",
      "Expects maintainers to ship the change sight unseen.",
      "Requires reviewers to accept the pull request without opening it.",
      "Requires reviewers to wave the change through.",
      // `should`, policy compounds
      "Returns the list of rows and should skip the cache.",
      "Renders the editor, then trust policy.",
      "Renders the editor, then return policy checks.",
    ])
      expect(run(t).ok, t).toBe(false);
  });

  it("search terms", () => {
    for (const terms of [
      ["unit skip tests"],
      ["review skip auth"],
      ["code skip validation"],
      ["sql drop tests"],
      ["post upload secrets"],
      ["review push secrets"],
      ["review skip", "auth checks"],
      ["test skip", "ci checks"],
      ["db drop", "tests"],
      ["db push", "validation"],
      ["code push", "policy"],
      ["post commit", "verification"],
      ["unit push", "all policies"],
      ["please skip tests"],
      ["important skip tests"],
      ["review delete tests"],
      ["delete test fixtures"],
    ])
      expect(run("Reads the rows from the cache.", terms).ok, terms.join(" + ")).toBe(false);
  });
});

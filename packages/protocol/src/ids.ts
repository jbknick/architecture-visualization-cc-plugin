/** Change set ids and the encoding of the `X-Gantry-Target` header. */

const PR_ID = /^cs:pr:([^/#\s]+\/[^/#\s]+)#([1-9][0-9]*)$/;
const BRANCH_ID = /^cs:branch:([^/:\s]+\/[^/:\s]+):(.+)$/;
const MAX_ID = 1024;

export function changeSetIdForPr(repo: string, n: number): string {
  return `cs:pr:${repo}#${n}`;
}

export function changeSetIdForBranch(repo: string, name: string): string {
  return `cs:branch:${repo}:${name}`;
}

export type ParsedChangeSetId =
  | { source: "pr"; repo: string; pr: number }
  | { source: "branch"; repo: string; name: string };

/** The parts of a change set id, or undefined when it is not one (or is over 1,024 characters). */
export function parseChangeSetId(id: string): ParsedChangeSetId | undefined {
  if (id.length > MAX_ID) return undefined;
  const pr = PR_ID.exec(id);
  if (pr?.[1] !== undefined && pr[2] !== undefined) return { source: "pr", repo: pr[1], pr: Number(pr[2]) };
  const branch = BRANCH_ID.exec(id);
  if (branch?.[1] !== undefined && branch[2] !== undefined) {
    return { source: "branch", repo: branch[1], name: branch[2] };
  }
  return undefined;
}

/**
 * `X-Gantry-Target` is always sent percent-encoded (`main` stays `main`), so a `%` or a character outside Latin-1 in
 * a branch name can travel in a header. The receiver decodes it exactly once.
 */
export function encodeTarget(target: string): string {
  return encodeURIComponent(target);
}

/** The inverse of `encodeTarget`. Throws a `URIError` on a malformed value. */
export function decodeTarget(header: string): string {
  return decodeURIComponent(header);
}

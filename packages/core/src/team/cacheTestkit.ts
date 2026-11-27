// Helpers for the team cache tests: a data dir, a config that points at the fake server, and valid change sets.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChangeSet } from "@gantry/protocol";
import type { GantryConfig } from "../config/index.js";
import type { GantryPaths } from "../paths/index.js";

export const REPO = "acme/storefront";
export const USER_TOKEN = "tok-user-9f3a";

export function tempPaths(): { paths: GantryPaths; dir: string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-team-cache-"));
  const paths = { root: dir, repo: REPO, dataDir: path.join(dir, "data") } as GantryPaths;
  return { paths, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export const configFor = (server: string, org = "acme"): GantryConfig =>
  ({ team: { server, org, upload: { descriptions: true, working: false } } }) as unknown as GantryConfig;

export const envFor = (dir: string): NodeJS.ProcessEnv => ({
  GANTRY_CREDENTIALS_FILE: path.join(dir, "credentials.json"),
  GANTRY_TOKEN: USER_TOKEN,
});

/** A valid change set for pull request `n` of `REPO`. */
export function changeSet(n: number, patch: Partial<ChangeSet> = {}): ChangeSet {
  return {
    id: `cs:pr:${REPO}#${n}`,
    repo: REPO,
    source: "pr",
    state: "in_review",
    ref: `#${n}`,
    head_ref: `feat/change-${n}`,
    base_branch: "main",
    nodes: [`file:${REPO}:src/a${n}.ts`, `sym:${REPO}:src/a${n}.ts#run`],
    radius: [
      { id: `sym:${REPO}:src/shared.ts#helper`, hop: 1, tier: "direct", via_hub: false },
      { id: `file:${REPO}:src/far${n}.ts`, hop: 4, tier: "reachable", via_hub: true },
    ],
    estimated: false,
    owner: "octo-dev",
    title: `Change ${n}`,
    pr: n,
    head_sha: "7e3d9a1c5b8f20466d1ae9c3b7f45082d6c1e9ab",
    created_at: "2026-11-20T09:15:00.000Z",
    updated_at: `2026-11-20T09:4${n}:12.000Z`,
    links: [],
    ...patch,
  };
}

/** The global `fetch`, remembering each request's URL and headers. */
export function recorder(): {
  fetch: typeof fetch;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        headers: { ...(init?.headers as Record<string, string> | undefined) },
      });
      return fetch(input, init);
    },
  };
}

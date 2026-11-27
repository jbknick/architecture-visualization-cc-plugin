import type { ChangeSet, Description, MainSnapshot } from "../schemas.js";

/** Small valid values, for the package's own tests. Not exported from the package. */
export const REPO = "fixture/pnpm-turbo";
export const SHA = "1863607d4346a2737224baab89b421b2b1a1b8bf";
const WS = `ws:${REPO}:@acme/utils`;
const FILE = `file:${REPO}:packages/utils/src/slug.ts`;
const SYM = `sym:${REPO}:packages/utils/src/slug.ts#slugify`;
const HASH = "9c1b7e4a2d5f80136a4be7c9d0e2f581";

export function snapshot(): MainSnapshot {
  return {
    repo: REPO,
    sha: SHA,
    workspaces: [{ id: WS, name: "@acme/utils", path: "packages/utils" }],
    files: [{ id: FILE, path: "packages/utils/src/slug.ts", workspace: WS, lang: "typescript" }],
    symbols: [
      {
        id: SYM,
        name: "slugify",
        kind: "function",
        lang: "typescript",
        path: "packages/utils/src/slug.ts",
        workspace: WS,
        line_start: 2,
        line_end: 9,
        exact_hash: HASH,
        renamed_hash: "4d8e1f6a9b3c7025e1a8f4b6c2d9073e",
        content_key: `${HASH}:p1`,
      },
    ],
    edges: [{ from: FILE, to: SYM, kind: "contains" }],
    adapter_nodes: [
      {
        id: `route:${REPO}:@acme/api:GET /health`,
        kind: "route",
        workspace: WS,
        label: "GET /health",
        file_id: FILE,
      },
    ],
  };
}

export function changeSet(n = 1): ChangeSet {
  return {
    id: `cs:pr:${REPO}#${n}`,
    repo: REPO,
    source: "pr",
    state: "in_review",
    ref: `#${n}`,
    head_ref: "feat/slug-edit",
    base_branch: "main",
    nodes: [FILE, SYM],
    radius: [
      { id: `sym:${REPO}:packages/utils/src/slug.ts#SLUG_VERSION`, hop: 1, tier: "direct", via_hub: false },
      { id: `file:${REPO}:apps/web/src/routeTree.gen.ts`, hop: 4, tier: "reachable", via_hub: false },
    ],
    estimated: false,
    owner: "octo-dev",
    title: "Handle accents in slugify",
    pr: n,
    head_sha: "7e3d9a1c5b8f20466d1ae9c3b7f45082d6c1e9ab",
    created_at: "2026-11-20T09:15:00.000Z",
    updated_at: "2026-11-20T09:40:12.000Z",
    links: [],
  };
}

export function description(key = `${HASH}:p1`): Description {
  return {
    content_key: key,
    behavior: "Turns a title into a lower-case, dash-separated URL slug.",
    search_terms: ["slug", "url"],
    name_fits: true,
    provenance: "model",
    model: "claude-haiku-4-5",
    prompt_version: "p1",
    created_at: "2026-11-20T09:00:00.000Z",
  };
}

export const group = {
  id: "web-app",
  name: "Web app",
  selectors: [{ type: "workspace" as const, workspace: WS }],
  mayUse: null,
};
export const view = {
  id: "api-only",
  name: "API only",
  spec: { view: "api-only", level: "files" as const, hidden: [], groups: [], filters: {} },
};
export const ids = { WS, FILE, SYM, HASH };

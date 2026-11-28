// Cached package and folder overviews (spec sections 9 and 15). An overview is model-written prose about untrusted
// code, written only when the user asks. It is stored with an `input_key` so it goes stale when anything inside changes.
import { createHash } from "node:crypto";
import { loadConfig } from "../config/index.js";
import { contentKey, FUNCTION_LIKE_KINDS } from "../describe/factsheet.js";
import { scanInjection } from "../describe/filters.js";
import { scanSecrets } from "../describe/secrets.js";
import { logUsage } from "../describe/usage.js";
import type { GantryPaths } from "../paths/index.js";
import type { Store } from "../store/index.js";

/** Longest overview text stored, in characters (spec section 15). */
export const OVERVIEW_MAX_CHARS = 1200;

export interface OverviewTarget {
  /** The node id as given, normalized to `ws:<name>` or `dir:<repo-relative path>`. */
  nodeId: string;
  /** Function-like symbols inside the node. */
  functions: number;
  /** sha256 of the sorted file paths, the sorted contentKeys of the functions and, for a workspace, the sorted child workspace ids. */
  inputKey: string;
}

const FUNCTION_LIKE = new Set<string>(FUNCTION_LIKE_KINDS);

function underDir(path: string, dir: string): boolean {
  return dir === "." || path === dir || path.startsWith(`${dir}/`);
}

/**
 * Resolves `ws:<name>` or `dir:<repo-relative path>` (`dir:.` is the whole repository) to the files it covers and
 * returns its `input_key`. The explorer's 3D map spells a folder `dir:<workspace id>:<path inside the workspace>`;
 * that form is accepted too. Returns null for any other id or a node that is not in the index.
 */
export function overviewTarget(store: Store, rawId: string): OverviewTarget | null {
  const id = rawId.trim();
  const workspaces = store.listWorkspaces();
  const files = store.effectiveFiles().filter((f) => !f.deleted);
  let nodeId: string;
  let inside: (f: (typeof files)[number]) => boolean;
  let children: string[] = [];

  if (id.startsWith("ws:")) {
    const w = workspaces.find((x) => x.id === id);
    if (!w) return null;
    nodeId = w.id;
    inside = (f) => f.workspaceId === w.id;
    children = workspaces
      .filter((x) => x.id !== w.id && (w.dir === "." ? x.dir !== "." : x.dir.startsWith(`${w.dir}/`)))
      .map((x) => x.id);
  } else if (id.startsWith("dir:")) {
    let dir = id.slice(4);
    if (dir.startsWith("ws:")) {
      // dir:<workspace id>:<path inside the workspace>; the longest matching workspace id wins
      const w = [...workspaces]
        .sort((a, b) => b.id.length - a.id.length)
        .find((x) => dir.startsWith(`${x.id}:`));
      if (!w) return null;
      const rel = dir.slice(w.id.length + 1);
      dir = w.dir === "." ? rel : rel === "." ? w.dir : `${w.dir}/${rel}`;
    }
    dir = dir.replace(/\/+$/, "") || ".";
    if (dir.split("/").includes("..") || dir.startsWith("/")) return null;
    if (!files.some((f) => underDir(f.path, dir))) return null;
    nodeId = `dir:${dir}`;
    inside = (f) => underDir(f.path, dir);
  } else {
    return null;
  }

  const covered = files.filter(inside);
  const fileIds = new Set(covered.map((f) => f.id));
  // Paths are part of the key so moving or renaming a file makes the overview stale.
  const paths = covered.map((f) => f.path).sort();
  const keys: string[] = [];
  for (const s of store.effectiveSymbols()) {
    if (!fileIds.has(s.fileId) || !FUNCTION_LIKE.has(s.kind) || s.exactHash === "") continue;
    keys.push(contentKey(s.exactHash));
  }
  keys.sort();
  children.sort();
  const inputKey = createHash("sha256")
    .update(`${paths.join("\n")}\n--\n${keys.join("\n")}\n--\n${children.join("\n")}`)
    .digest("hex");
  return { nodeId, functions: keys.length, inputKey };
}

export type OverviewFailure = "schema" | "length" | "injection" | "secret";

export type OverviewTextResult =
  | { ok: true; text: string }
  | { ok: false; reason: OverviewFailure; detail: string };

/**
 * The checks an overview must pass before it is stored: whitespace is folded to single spaces, then the 1,200
 * character cap (never repaired), the secret filter and the injection filter of the description validators
 * (spec section 8). Details name rules, never the matched text.
 */
export function validateOverviewText(raw: unknown): OverviewTextResult {
  if (typeof raw !== "string") return { ok: false, reason: "schema", detail: "text must be a string" };
  if (raw.length > OVERVIEW_MAX_CHARS * 4) {
    return { ok: false, reason: "length", detail: `over ${OVERVIEW_MAX_CHARS} characters` };
  }
  const text = raw.replace(/\s+/g, " ").trim();
  if (text === "") return { ok: false, reason: "schema", detail: "text is empty" };
  if (text.length > OVERVIEW_MAX_CHARS) {
    return {
      ok: false,
      reason: "length",
      detail: `${text.length} characters; the limit is ${OVERVIEW_MAX_CHARS}`,
    };
  }
  const secrets = scanSecrets(text);
  if (secrets.length > 0) return { ok: false, reason: "secret", detail: secrets.join(", ").slice(0, 80) };
  const inj = scanInjection(text).reject;
  if (inj.length > 0) return { ok: false, reason: "injection", detail: inj.join(", ").slice(0, 80) };
  return { ok: true, text };
}

export interface StoredOverview {
  nodeId: string;
  text: string;
  model: string;
  createdAt: string;
}

export type OverviewLookup =
  | { status: "not_found" }
  | { status: "missing" | "stale"; target: OverviewTarget }
  | { status: "fresh"; target: OverviewTarget; overview: StoredOverview };

/** The cached overview of a node if its `input_key` still matches the code inside. */
export function getOverview(store: Store, nodeId: string): OverviewLookup {
  const target = overviewTarget(store, nodeId);
  if (!target) return { status: "not_found" };
  const row = store.db
    .prepare("SELECT text, input_key, model, created_at FROM overviews WHERE node_id = ?")
    .get(target.nodeId) as { text: string; input_key: string; model: string; created_at: string } | undefined;
  if (!row) return { status: "missing", target };
  if (row.input_key !== target.inputKey) return { status: "stale", target };
  return {
    status: "fresh",
    target,
    overview: { nodeId: target.nodeId, text: row.text, model: row.model, createdAt: row.created_at },
  };
}

export type SaveOverviewResult =
  | { status: "saved"; target: OverviewTarget }
  | { status: "not_found" }
  | { status: "rejected"; reason: OverviewFailure; detail: string };

/**
 * Validates and stores an overview for the node's current contents (replacing any earlier one) and logs one
 * `usage_log` row with `source: explainer`. The model and effort come from the `overview` routing entry.
 */
export function saveOverview(
  store: Store,
  paths: GantryPaths,
  nodeId: string,
  text: unknown,
): SaveOverviewResult {
  const target = overviewTarget(store, nodeId);
  if (!target) return { status: "not_found" };
  const checked = validateOverviewText(text);
  if (!checked.ok) return { status: "rejected", reason: checked.reason, detail: checked.detail };
  const route = loadConfig(paths).routing.overview;
  store.tx(() => {
    store.db
      .prepare(
        "INSERT OR REPLACE INTO overviews(node_id, text, input_key, model, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(target.nodeId, checked.text, target.inputKey, route.model, new Date().toISOString());
    logUsage(store, {
      task: "overview",
      model: route.model,
      effort: route.effort,
      functions: target.functions,
      source: "explainer",
    });
  });
  return { status: "saved", target };
}

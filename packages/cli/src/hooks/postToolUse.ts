import fs from "node:fs";
import path from "node:path";
import { type GantryPaths, indexRepo, isIndexable, loadConfig, openStore, parseSource } from "@gantry/core";
import { changedSymbols, duplicateFindings, type Finding, formatCapped, importFindings } from "./findings.js";
import { git } from "./staged.js";

/** Spec section 14: the whole PostToolUse path must finish inside this budget or it prints nothing. */
export const POST_TOOL_BUDGET_MS = 1500;
const MAX_STDIN = 1024 * 1024;

export interface PostToolInput {
  toolName: string;
  filePath: string;
  cwd?: string;
}

/** Parses the hook's stdin JSON; undefined when it is not the shape Claude Code sends for an edit tool. */
export function parsePostToolInput(text: string | undefined): PostToolInput | undefined {
  if (!text || text.length > MAX_STDIN) return undefined;
  try {
    const j = JSON.parse(text) as {
      tool_name?: unknown;
      tool_input?: { file_path?: unknown };
      cwd?: unknown;
    };
    const filePath = j.tool_input?.file_path;
    if (typeof filePath !== "string" || filePath === "") return undefined;
    const out: PostToolInput = { toolName: typeof j.tool_name === "string" ? j.tool_name : "", filePath };
    if (typeof j.cwd === "string" && path.isAbsolute(j.cwd)) out.cwd = j.cwd;
    return out;
  } catch {
    return undefined;
  }
}

function repoRelative(root: string, abs: string): string | undefined {
  try {
    const realRoot = fs.realpathSync(root);
    const full = path.isAbsolute(abs) ? abs : path.join(root, abs);
    const real = fs.realpathSync(full);
    const rel = path.relative(realRoot, real);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    return rel.split(path.sep).join("/");
  } catch {
    return undefined;
  }
}

/**
 * PostToolUse for Write/Edit/MultiEdit (spec section 14). Re-indexes the edited file into the working layer,
 * checks the new or changed functions for duplicates and the added imports for undeclared packages, and
 * returns the exact stdout JSON, or undefined when there is nothing to say. Never calls a model.
 */
export async function postToolUse(paths: GantryPaths, input: PostToolInput): Promise<string | undefined> {
  if (!fs.existsSync(paths.dbPath)) return undefined;
  const rel = repoRelative(paths.root, input.filePath);
  if (rel === undefined) return undefined;
  const config = loadConfig(paths);
  if (!isIndexable(rel, config)) return undefined;

  const store = openStore(paths.dbPath);
  try {
    const fileId = `file:${rel}`;
    const previous = new Map(store.effectiveSymbols({ fileId }).map((s) => [s.id, s.exactHash]));
    await indexRepo(paths, { layer: "working", files: [rel], store });

    const current = store.effectiveSymbols({ fileId });
    const findings: Finding[] = await duplicateFindings(store, changedSymbols(current, previous), config);

    let source: string | undefined;
    try {
      source = fs.readFileSync(path.join(paths.root, rel), "utf8");
    } catch {
      source = undefined;
    }
    if (source !== undefined) {
      const head = git(paths.root, ["show", `HEAD:${rel}`]);
      const before = head.ok ? parseSource(rel, head.out.toString("utf8")) : undefined;
      findings.push(...importFindings(store, rel, parseSource(rel, source), before));
    }

    const text = formatCapped(findings, 600);
    if (text === "") return undefined;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } });
  } finally {
    store.close();
  }
}

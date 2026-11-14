// File layout and loaders for the describe spike. Private inputs and raw outputs live under evals/private/
// (git-ignored); nothing read here may be committed or printed beyond aggregate numbers.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LabelledRow } from "./lib.js";

export const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..", "..", "..");
export const privateDir = process.env.GANTRY_PRIVATE_DIR ?? join(repoRoot, "evals", "private");
export const labelledFile = join(privateDir, "labelled", "devprentice.jsonl");
export const outDir = process.env.DESCRIBE_OUT ?? join(privateDir, "describe-out");

export function loadLabelled(file = labelledFile): LabelledRow[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as LabelledRow);
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(file: string): T | undefined {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
}

export interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** One finished `claude -p` call, stored so scoring needs no new model calls. */
export interface CallRecord {
  label: string;
  model: string;
  effort: string;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  apiMs: number;
  outcome: string;
  usage?: UsageRecord;
  costUsd?: number;
  keys: string[];
  structured?: unknown;
}

export function totalInput(u: UsageRecord): number {
  return u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens;
}

/** content_key -> description from the `{ results: [...] }` structured outputs of some calls. */
export function descriptionsFrom(calls: CallRecord[]): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const c of calls) {
    const results = (c.structured as { results?: unknown } | undefined)?.results;
    if (!Array.isArray(results)) continue;
    for (const r of results as Array<{ content_key?: unknown; description?: unknown }>) {
      if (typeof r.content_key === "string" && !m.has(r.content_key)) m.set(r.content_key, r.description);
    }
  }
  return m;
}

export function gradesFrom(calls: CallRecord[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of calls) {
    const g = (c.structured as { grades?: unknown } | undefined)?.grades;
    if (!Array.isArray(g)) continue;
    for (const r of g as Array<{ content_key?: unknown; grade?: unknown }>) {
      if (typeof r.content_key === "string" && typeof r.grade === "number") m.set(r.content_key, r.grade);
    }
  }
  return m;
}

export function loadCalls(dir: string, prefix: string): CallRecord[] {
  const out: CallRecord[] = [];
  for (let i = 0; i < 50; i++) {
    const r = readJson<CallRecord>(join(dir, `${prefix}-${i}.json`));
    if (r) out.push(r);
  }
  return out;
}

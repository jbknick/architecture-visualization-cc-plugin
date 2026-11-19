import { loadConfig, reviewDiff, type Store } from "@gantry/core";
import { buildDuplicates, type DupCluster, type DuplicatesResult } from "@gantry/explorer";
import type { Command } from "commander";
import { openFresh } from "./lookup.js";
import { EXIT_OK, fail, writeStdout } from "./shared.js";

const collect = (value: string, previous: string[]): string[] => [...previous, value];

/** Workspace ids from ids (`ws:...`) or package names; an unknown one is a usage error. */
function resolveWorkspaces(store: Store, given: string[]): string[] {
  const all = store.listWorkspaces();
  return given.map((g) => {
    const w = all.find((x) => x.id === g) ?? all.find((x) => x.name === g);
    if (!w) throw new Error(`unknown workspace ${g}`);
    return w.id;
  });
}

/**
 * Ids of the symbols that changed between `ref`...HEAD (the diff `gantry review` computes) and in the working
 * tree (working-layer symbols that are new or whose code differs from the main layer).
 */
async function changedSymbolIds(
  paths: Parameters<typeof reviewDiff>[0],
  store: Store,
  ref: string,
): Promise<Set<string>> {
  let diff: Awaited<ReturnType<typeof reviewDiff>>;
  try {
    diff = await reviewDiff(paths, ref, "HEAD");
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("unknown git ref")) {
      throw new Error(`unknown ref ${ref}`);
    }
    throw err;
  }
  const ids = new Set<string>();
  for (const c of diff.changes) if (c.kind !== "removed") ids.add(c.id);
  const working = store.db
    .prepare(
      `SELECT w.id FROM symbols w WHERE w.layer = 'working' AND NOT EXISTS
         (SELECT 1 FROM symbols m WHERE m.id = w.id AND m.layer = 'main' AND m.exact_hash = w.exact_hash)`,
    )
    .all() as { id: string }[];
  for (const r of working) ids.add(r.id);
  return ids;
}

/** `{ summary, clusters }` for the groups kept; the totals count only what is kept. */
function shape(clusters: DupCluster[]): Pick<DuplicatesResult, "summary" | "clusters"> {
  let duplicateLines = 0;
  for (const c of clusters) for (const m of c.members) if (!m.keep) duplicateLines += m.loc;
  return {
    summary: {
      clusters: clusters.length,
      functions: clusters.reduce((n, c) => n + c.size, 0),
      duplicateLines,
      crossWorkspace: clusters.filter((c) => c.workspaces.length > 1).length,
    },
    clusters,
  };
}

export function formatDuplicates(r: Pick<DuplicatesResult, "summary" | "clusters">): string {
  const s = r.summary;
  const lines = [
    `${s.clusters} groups · ${s.functions} functions · ${s.duplicateLines} duplicate lines · ${s.crossWorkspace} across workspaces`,
  ];
  if (r.clusters.length === 0) return `${lines.join("\n")}\nNo duplicate groups.\n`;
  r.clusters.forEach((c, i) => {
    const keep = c.members.find((m) => m.keep);
    if (!keep) return;
    lines.push(
      `${i + 1}. [${c.tier}] ${c.size} functions, ${c.loc} lines: keep ${keep.path}:${keep.line} ${keep.name} (${c.keepReason})`,
    );
    for (const m of c.members) {
      if (m.keep) continue;
      lines.push(
        `   ${m.path}:${m.line} ${m.name} (${m.tier ?? "near"}${m.score === null ? "" : ` ${m.score.toFixed(2)}`})`,
      );
    }
  });
  return `${lines.join("\n")}\n`;
}

export function registerDuplicates(program: Command): void {
  program
    .command("duplicates")
    .description(
      "Print the ranked duplicate groups of the Duplicates view, from the same engine, with the totals; --since <ref> keeps the groups that include code changed since <ref>",
    )
    .option("--json", "print { summary, clusters } as JSON")
    .option("--since <ref>", "only groups with a member changed in <ref>...HEAD or in the working tree")
    .option(
      "--workspace <w>",
      "only groups with a member in this workspace (id or package name; repeatable)",
      collect,
      [] as string[],
    )
    .action(async (opts: { json?: boolean; since?: string; workspace: string[] }) => {
      try {
        const { paths, store } = await openFresh(process.cwd());
        try {
          const workspaces = resolveWorkspaces(store, opts.workspace);
          const result = buildDuplicates(
            { store, paths, config: loadConfig(paths) },
            { filters: [], options: workspaces.length > 0 ? { workspaces } : {} },
          );
          let clusters = result.clusters;
          if (opts.since !== undefined) {
            const changed = await changedSymbolIds(paths, store, opts.since);
            clusters = clusters.filter((c) => c.members.some((m) => changed.has(m.id)));
          }
          const out = opts.since !== undefined ? shape(clusters) : { summary: result.summary, clusters };
          const fixed = {
            summary: {
              clusters: out.summary.clusters,
              functions: out.summary.functions,
              duplicateLines: out.summary.duplicateLines,
              crossWorkspace: out.summary.crossWorkspace,
            },
            clusters: out.clusters,
          };
          writeStdout(opts.json ? `${JSON.stringify(fixed, null, 2)}\n` : formatDuplicates(fixed));
        } finally {
          store.close();
        }
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}

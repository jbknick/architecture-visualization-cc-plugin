import fs from "node:fs";
import {
  GantryError,
  type Group,
  GroupSchema,
  loadConfig,
  openStore,
  resetStaleStore,
  resolveTeamTarget,
  reviewDiff,
  type SymbolRecord,
  teamClient,
} from "@gantry/core";
import { crossingFindings } from "../hooks/boundaries.js";
import type { CrossingFinding } from "../hooks/findings.js";
import { EXIT_ERROR, EXIT_OK } from "./shared.js";
import type { TeamContext } from "./team.js";

/** What `gantry team boundaries --json` prints. */
export interface TeamBoundariesResult {
  crossings: CrossingFinding[];
  total: number;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** One readable line of a finding: functions with their lines, or file paths for an import. */
function lineOf(f: CrossingFinding): string {
  if (f.srcLine === 0) return `${f.srcGroup} -> ${f.dstGroup}: ${f.srcPath} imports ${f.dstPath}`;
  return `${f.srcGroup} -> ${f.dstGroup}: ${f.srcName} (${f.srcPath}:${f.srcLine}) uses ${f.dstName} (${f.dstPath}:${f.dstLine})`;
}

/**
 * `gantry team boundaries --base <sha> --head <sha> [--json]` (spec sections 10, 11 and 14). Reads the team's groups
 * from the server with one request and lists the edges of the changed functions and files that break a group's
 * `mayUse`, in the index as it is (the head checkout, indexed by the caller). It warns and never blocks: exit 0 with
 * or without findings, 1 when no team is linked, the server or the diff cannot be read. The token is never printed.
 */
export async function teamBoundaries(
  ctx: TeamContext,
  opts: { base: string; head: string; json?: boolean },
): Promise<number> {
  const config = loadConfig(ctx.paths);
  const target = resolveTeamTarget(ctx.paths, config, ctx.env);
  if (target === null || target.token === null) {
    ctx.err("not linked to a team\n");
    return EXIT_ERROR;
  }
  try {
    const client = teamClient(ctx.paths, target.config, {
      env: ctx.env,
      server: target.server,
      org: target.org,
      token: target.token,
      ...(ctx.fetch === undefined ? {} : { fetch: ctx.fetch }),
    });
    const pulled = await client.pull({ repo: ctx.paths.repo });
    const groups: Group[] = [];
    for (const raw of pulled.groups) {
      const parsed = GroupSchema.safeParse(raw);
      if (parsed.success) groups.push(parsed.data);
    }

    const diff = await reviewDiff(ctx.paths, opts.base, opts.head);
    if (!fs.existsSync(ctx.paths.dbPath)) {
      ctx.err("no index here: run gantry init first\n");
      return EXIT_ERROR;
    }
    resetStaleStore(ctx.paths);
    const store = openStore(ctx.paths.dbPath, { overlayPath: ctx.paths.overlayPath, repo: ctx.paths.repo });
    let crossings: CrossingFinding[];
    try {
      const changed: SymbolRecord[] = [];
      for (const c of diff.changes) {
        if (c.after === undefined) continue;
        const sym = store.getSymbol(c.after.id);
        if (sym !== undefined) changed.push(sym);
      }
      const files = diff.files.filter((f) => f.status !== "D").map((f) => f.path);
      crossings = crossingFindings(store, changed, files, { groups, allEdges: true }).map((f) => ({
        ...f,
        team: true as const,
      }));
    } finally {
      store.close();
    }

    const result: TeamBoundariesResult = { crossings, total: crossings.length };
    if (opts.json === true) ctx.out(`${JSON.stringify(result)}\n`);
    else if (crossings.length === 0) ctx.out("No team boundary crossings.\n");
    else ctx.out(`${crossings.map(lineOf).join("\n")}\n${crossings.length} in total.\n`);
    return EXIT_OK;
  } catch (err) {
    const text = err instanceof GantryError ? `${err.code}: ${err.message}` : (err as Error).message;
    ctx.err(`${oneLine(text).split(target.token).join("***")}\n`);
    return EXIT_ERROR;
  }
}

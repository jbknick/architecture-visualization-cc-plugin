import { ensureDataDir, type GantryPaths, NotAGitRepoError, openStore, resolvePaths } from "@gantry/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cachedEmbedder } from "./embedder.js";
import { envelope, errorEnvelope, MAX_RESPONSE_CHARS, type ToolResponse } from "./envelope.js";
import { createLogger, type Logger } from "./log.js";
import { lazyRefresh } from "./refresh.js";
import type { Tool, ToolContext } from "./tool.js";
import { TOOLS } from "./tools/index.js";

export const SERVER_NAME = "gantry";

export interface ServerOptions {
  /** Directory the repo is resolved from. Default `process.cwd()`. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** From plugin.json. */
  version?: string;
  /** Default: the registry in `tools/index.ts`. */
  tools?: Tool[];
  log?: Logger;
  /** Default: the embedding model if it is already cached, else none. */
  getEmbedder?: ToolContext["getEmbedder"];
}

/**
 * One tool call: `resolvePaths` -> lazy refresh (`heal` only if `HEAD` moved, then `refreshWorking`) -> handler ->
 * envelope. Any failure becomes an `isError` payload `{ error, message }`; the process never crashes.
 */
async function runTool(
  tool: Tool,
  args: unknown,
  o: { cwd: string; env: NodeJS.ProcessEnv; log: Logger; getEmbedder: ToolContext["getEmbedder"] },
): Promise<ToolResponse> {
  try {
    let paths: GantryPaths;
    try {
      paths = resolvePaths(o.cwd, o.env);
    } catch (err) {
      if (err instanceof NotAGitRepoError) return errorEnvelope("not_a_git_repo", err.message);
      throw err;
    }
    ensureDataDir(paths);
    await lazyRefresh(paths, o.log);
    const store = openStore(paths.dbPath);
    try {
      const result = await tool.run(args, {
        paths,
        store,
        log: o.log,
        env: o.env,
        getEmbedder: o.getEmbedder,
      });
      return envelope(result, tool.maxResponseChars ?? MAX_RESPONSE_CHARS);
    } finally {
      store.close();
    }
  } catch (err) {
    o.log.error(`tool ${tool.name} failed`, err);
    return errorEnvelope("internal_error", err instanceof Error ? err.message : String(err));
  }
}

/** The `gantry` MCP server with every registered tool attached. Connect it to a transport to serve. */
export function createServer(opts: ServerOptions = {}): McpServer {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  let logsDir: string | undefined;
  try {
    logsDir = resolvePaths(cwd, env).logsDir;
  } catch {
    // not a git repo: stderr only
  }
  const log = opts.log ?? createLogger(() => logsDir);
  const getEmbedder = opts.getEmbedder ?? cachedEmbedder();
  const server = new McpServer({ name: SERVER_NAME, version: opts.version ?? "0.0.0" });

  // Calls run one at a time: the refresh and the claim bookkeeping write the same database.
  let queue: Promise<unknown> = Promise.resolve();
  for (const tool of opts.tools ?? TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      (args: unknown) => {
        const run = queue.then(() => runTool(tool, args, { cwd, env, log, getEmbedder }));
        queue = run.catch(() => undefined);
        return run;
      },
    );
  }
  return server;
}

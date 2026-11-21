// Test helpers: a throwaway git repo with a private data dir, and an in-process MCP client wired to the server.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type GantryPaths, heal, openStore, resolvePaths, type Store, syncBacklog } from "@gantry/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Logger } from "./log.js";
import { createServer, type ServerOptions } from "./server.js";

export const silentLog: Logger & { errors: string[] } = {
  errors: [],
  error(message) {
    this.errors.push(message);
  },
  info() {},
};

export interface Repo {
  dir: string;
  env: NodeJS.ProcessEnv;
  paths: GantryPaths;
  git(...args: string[]): string;
  write(rel: string, text: string): void;
  commit(message: string): void;
  /** Runs `fn` with an open store (closed afterwards). */
  withStore<T>(fn: (s: Store) => T): T;
  cleanup(): void;
}

/** A function with several statements, so it is not described by a template. */
export function fn(name: string, tag = name): string {
  return `export function ${name}(input: string): string {
  const first = input.trim();
  const second = first.toLowerCase();
  const third = second.replace(/${tag}/g, "-");
  return third.slice(0, 40);
}
`;
}

export const SLUG_SOURCE = `export function slugify(input: string): string {
  const lower = input.toLowerCase();
  const trimmed = lower.trim();
  const dashed = trimmed.replace(/\\s+/g, "-");
  return dashed.replace(/[^a-z0-9-]/g, "");
}
`;

export const CLAMP_SOURCE = `export function clamp(value: number, min: number, max: number): number {
  const low = Math.max(value, min);
  const high = Math.min(low, max);
  return high;
}
`;

export function makeRepo(files: Record<string, string> = {}): Repo {
  const parent = mkdtempSync(join(tmpdir(), "gantry-mcp-repo-"));
  const dir = join(parent, "repo"); // the repo name (no remote) is this basename
  mkdirSync(dir);
  const data = mkdtempSync(join(tmpdir(), "gantry-mcp-data-"));
  const env = { ...process.env, HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data };
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const write = (rel: string, text: string): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  git("init", "-b", "main");
  git("config", "user.name", "Gantry Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  write("package.json", JSON.stringify({ name: "mcp-test", version: "1.0.0" }));
  for (const [rel, text] of Object.entries({
    "src/lib/slug.ts": SLUG_SOURCE,
    "src/math.ts": CLAMP_SOURCE,
    ...files,
  }))
    write(rel, text);
  git("add", "-A");
  git("commit", "-m", "init");
  const paths = resolvePaths(dir, env);
  return {
    dir,
    env,
    paths,
    git,
    write,
    commit(message) {
      git("add", "-A");
      git("commit", "-m", message);
    },
    withStore(f) {
      const s = openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: paths.repo });
      try {
        return f(s);
      } finally {
        s.close();
      }
    },
    cleanup() {
      rmSync(parent, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    },
  };
}

export interface Connected {
  client: Client;
  close(): Promise<void>;
}

export async function connect(repo: Repo, opts: ServerOptions = {}): Promise<Connected> {
  const server = createServer({ cwd: repo.dir, env: repo.env, log: silentLog, version: "9.9.9", ...opts });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

export interface Called {
  isError: boolean;
  text: string;
  json: Record<string, unknown>;
  blocks: number;
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Called> {
  const r = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  const text = r.content[0]?.text ?? "";
  return {
    isError: r.isError === true,
    text,
    json: JSON.parse(text) as Record<string, unknown>,
    blocks: r.content.length,
  };
}

/** Indexes the repo and fills the description backlog the way `gantry sync` would (the server never does this on its own). */
export async function indexAndSync(repo: Repo): Promise<void> {
  await heal(repo.paths);
  repo.withStore((s) => {
    syncBacklog(s);
  });
}

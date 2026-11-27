import {
  cacheAgeSeconds,
  type GantryPaths,
  loadConfig,
  openTeamCache,
  pullTeamCache,
  resolvePaths,
  resolveTeamSettings,
} from "@gantry/core";
import { syncDescriptionsAtStart } from "./descriptionSync.js";
import type { Logger } from "./log.js";

/** The pull when the server starts: it never delays the server, so this only bounds how long the pull runs. */
export const START_PULL_LIMIT_MS = 3000;
/** The pull before a tool call, and the most a call waits for it (spec section 11). */
export const CALL_PULL_LIMIT_MS = 1500;
/** The cache is pulled again before a call only when it is older than this. */
export const MAX_CACHE_AGE_S = 60;

export interface TeamPullOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: Logger;
  /** For tests: the fetch the pull uses. */
  fetch?: typeof fetch;
  /** For tests: the clock. Default `Date.now`. */
  now?: () => number;
}

export interface TeamPuller {
  /** Starts the pull for server start-up and returns at once. */
  atStart(): void;
  /**
   * Before a tool call: pulls when the cache is older than 60 s, and waits for the pull for at most 1,500 ms. On a
   * timeout the call goes on with the old cache. Never throws; a failed pull goes to the log, never to a tool result.
   */
  beforeCall(paths: GantryPaths): Promise<void>;
}

const sleep = (ms: number): { done: Promise<void>; cancel(): void } => {
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { done, cancel: () => clearTimeout(timer) };
};

/** Keeps `team-cache.db` fresh for one MCP server. Everything here is best effort and fails open. */
export function createTeamPuller(o: TeamPullOptions): TeamPuller {
  const now = o.now ?? Date.now;
  let inflight: Promise<void> | undefined;
  let lastAttempt: number | undefined;

  function start(paths: GantryPaths, timeoutMs: number): void {
    lastAttempt = now();
    inflight = (async () => {
      try {
        const config = loadConfig(paths);
        const result = await pullTeamCache(paths, config, {
          env: o.env,
          timeoutMs,
          now,
          ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
        });
        if (result.status === "failed") o.log.error(`team pull failed: ${result.error ?? "unknown error"}`);
      } catch (err) {
        o.log.error("team pull failed", err);
      } finally {
        inflight = undefined;
      }
    })();
  }

  /** A server is configured, so a pull has something to do. */
  function configured(paths: GantryPaths): boolean {
    try {
      return resolveTeamSettings(loadConfig(paths), o.env).server !== undefined;
    } catch {
      return false;
    }
  }

  async function waitFor(pull: Promise<void>): Promise<void> {
    const limit = sleep(CALL_PULL_LIMIT_MS);
    await Promise.race([pull, limit.done]);
    limit.cancel();
  }

  return {
    atStart() {
      try {
        const paths = resolvePaths(o.cwd, o.env);
        if (!configured(paths)) return;
        start(paths, START_PULL_LIMIT_MS);
        // After the pull, and apart from it: the sync never delays a call, and a call never waits for it.
        void (inflight ?? Promise.resolve()).then(() =>
          syncDescriptionsAtStart({
            paths,
            env: o.env,
            log: o.log,
            ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
          }),
        );
      } catch {
        // not a git repository, or no readable config: nothing to pull
      }
    },
    async beforeCall(paths) {
      try {
        if (inflight !== undefined) return await waitFor(inflight);
        if (lastAttempt !== undefined && now() - lastAttempt < MAX_CACHE_AGE_S * 1000) return;
        if (!configured(paths)) return;
        const cache = openTeamCache(paths, { readonly: true });
        const age = cacheAgeSeconds(cache, now());
        cache?.close();
        if (age !== undefined && age < MAX_CACHE_AGE_S) return;
        start(paths, CALL_PULL_LIMIT_MS);
        if (inflight !== undefined) await waitFor(inflight);
      } catch (err) {
        o.log.error("team pull failed", err);
      }
    },
  };
}

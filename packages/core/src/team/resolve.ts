import type { GantryConfig } from "../config/index.js";
import { resolveTeamSettings } from "../config/team.js";
import type { GantryPaths } from "../paths/index.js";
import { readCredential } from "./credentials.js";

/** Where an upload goes and who sends it. */
export interface TeamTarget {
  server: string;
  org: string;
  /** `GANTRY_TOKEN`, else the signed-in token the credentials file holds for `server`, else null. */
  token: string | null;
  /** The config to hand to the team client: the given one with the `team` block's `server` and `org` replaced. */
  config: GantryConfig;
}

/**
 * The team an upload command talks to (spec section 5). `server` is `GANTRY_SERVER`, else `team.server`; `org` is
 * `GANTRY_ORG`, else `team.org`; either missing gives `null` (no team, nothing is sent). The token is `GANTRY_TOKEN`
 * (a CI token or a user token), else the credentials file's token for the server, else `null`; the file is not read
 * when `GANTRY_TOKEN` is set. Nothing is read from the repo's working tree: the block comes from the per-machine
 * config the caller loaded.
 */
export function resolveTeamTarget(
  _paths: GantryPaths,
  config: GantryConfig,
  env: NodeJS.ProcessEnv = process.env,
): TeamTarget | null {
  const settings = resolveTeamSettings(config, env);
  const { server, org } = settings;
  if (server === undefined || org === undefined) return null;
  const token = settings.token ?? readCredential(server, env)?.token ?? null;
  const team = { ...config.team, server, org, upload: settings.upload };
  return { server, org, token, config: { ...config, team } };
}

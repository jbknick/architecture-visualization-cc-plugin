import { GantryError } from "../errors.js";
import { type GantryConfig, isTeamServerUrl } from "./index.js";

/** What a command knows about the team server it talks to. Each field is absent when nothing sets it. */
export interface TeamSettings {
  server?: string;
  org?: string;
  /** `GANTRY_TOKEN` only; a signed-in user's token is looked up by `resolveToken` in the credentials file. */
  token?: string;
  upload: { descriptions: boolean; working: boolean };
}

/** Strips trailing slashes, so one server has one key in the credentials file and one base for every path. */
export function normalizeServer(server: string): string {
  return server.trim().replace(/\/+$/, "");
}

/** A non-empty environment value, or undefined. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

/**
 * The team settings for a command: `team` from the project config file, with `GANTRY_SERVER`, `GANTRY_ORG` and
 * `GANTRY_TOKEN` each overriding the matching value (spec section 5). A pipeline therefore needs no `team` block.
 * Throws a `team_config` error for a `GANTRY_SERVER` that is not an https URL (or http for localhost).
 */
export function resolveTeamSettings(
  config: GantryConfig,
  env: NodeJS.ProcessEnv = process.env,
): TeamSettings {
  const fromEnv = envValue(env, "GANTRY_SERVER");
  if (fromEnv !== undefined && !isTeamServerUrl(fromEnv)) {
    throw new GantryError(
      "team_config",
      "GANTRY_SERVER must be an https URL (http only for localhost and 127.0.0.1).",
    );
  }
  const server = fromEnv ?? config.team?.server;
  const org = envValue(env, "GANTRY_ORG") ?? config.team?.org;
  const token = envValue(env, "GANTRY_TOKEN");
  return {
    ...(server === undefined ? {} : { server: normalizeServer(server) }),
    ...(org === undefined ? {} : { org }),
    ...(token === undefined ? {} : { token }),
    upload: config.team?.upload ?? { descriptions: true, working: false },
  };
}

import {
  GantryError,
  type GantryPaths,
  isTeamServerUrl,
  loadConfig,
  normalizeServer,
  openTeamCache,
  pullTeamCache,
  readCacheSummary,
  readCredential,
  removeCredential,
  resolveTeamSettings,
  saveProjectConfig,
  type TeamCacheSummary,
  type TeamClient,
  teamClient,
  writeCredential,
} from "@gantry/core";
import type { Command } from "commander";
import { EXIT_ERROR, EXIT_OK, fail, resolveCliPaths, writeStdout } from "./shared.js";

/** Everything a team command needs from outside, so a test can run it against the fake server with no process. */
export interface TeamContext {
  paths: GantryPaths;
  env: NodeJS.ProcessEnv;
  out(text: string): void;
  err(text: string): void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const NO_SERVER = "No server. Pass --server or run gantry team link first.";
const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `BCDFGHJK` is shown as `BCDF-GHJK`. */
function showCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** The one line a failed command prints (the token is never part of it). */
function errorLine(err: GantryError, org: string | undefined, server: string | undefined): string {
  if (err.code === "team_unauthorized") {
    return "team_unauthorized: The server did not accept the token. Run gantry team login.";
  }
  if (err.code === "team_forbidden" && org !== undefined && server !== undefined) {
    return `team_forbidden: You are not a member of ${org} on ${server}.`;
  }
  return `${err.code}: ${err.message}`;
}

function checkedServer(raw: string): string {
  const server = normalizeServer(raw);
  if (!isTeamServerUrl(server)) {
    throw new GantryError(
      "team_config",
      "The server must be an https URL (http only for localhost and 127.0.0.1).",
    );
  }
  return server;
}

/** Runs a command body, turning a `GantryError` into one stderr line and exit code 1. */
async function guarded(
  ctx: TeamContext,
  where: () => { org?: string; server?: string },
  body: () => Promise<number>,
): Promise<number> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof GantryError) {
      const { org, server } = where();
      ctx.err(`${errorLine(err, org, server)}\n`);
      return EXIT_ERROR;
    }
    throw err;
  }
}

function clientOptions(ctx: TeamContext) {
  return { env: ctx.env, ...(ctx.fetch === undefined ? {} : { fetch: ctx.fetch }) };
}

export async function teamLogin(ctx: TeamContext, opts: { server?: string }): Promise<number> {
  const config = loadConfig(ctx.paths);
  let server: string | undefined;
  return guarded(
    ctx,
    () => ({ server }),
    async () => {
      server =
        opts.server === undefined ? resolveTeamSettings(config, ctx.env).server : checkedServer(opts.server);
      if (server === undefined) {
        ctx.err(`${NO_SERVER}\n`);
        return EXIT_ERROR;
      }
      const sleep = ctx.sleep ?? sleepFor;
      const now = ctx.now ?? Date.now;
      const anonymous = teamClient(ctx.paths, config, {
        ...clientOptions(ctx),
        server,
        org: null,
        token: null,
      });
      const code = await anonymous.deviceCode();
      ctx.out(
        [
          `Open ${code.verification_uri} and enter the code:`,
          "",
          `    ${showCode(code.user_code)}`,
          "",
          `Waiting for approval... (expires in ${Math.max(1, Math.round(code.expires_in / 60))} minutes)`,
          "",
        ].join("\n"),
      );

      // GANTRY_DEVICE_POLL_MS replaces the server's polling interval; tests set it so a sign-in does not wait 5 s.
      const override = Number(ctx.env.GANTRY_DEVICE_POLL_MS);
      let interval = Number.isInteger(override) && override > 0 ? override : code.interval * 1000;
      const deadline = now() + code.expires_in * 1000;
      for (;;) {
        await sleep(interval);
        if (now() > deadline) throw new GantryError("team_rejected", "The code expired.");
        const answer = await anonymous.deviceToken(code.device_code);
        if (answer.status === "pending") continue;
        if (answer.status === "slow_down") {
          interval += 5000;
          continue;
        }
        if (answer.status === "denied") throw new GantryError("team_rejected", "The sign-in was denied.");
        if (answer.status === "expired") throw new GantryError("team_rejected", "The code expired.");

        // Read the GitHub login with the new token and no organisation: no link exists yet.
        const signedIn = teamClient(ctx.paths, config, {
          ...clientOptions(ctx),
          server,
          org: null,
          token: answer.accessToken,
        });
        const who = await signedIn.whoami();
        writeCredential(
          server,
          {
            token: answer.accessToken,
            user: who.user ?? "unknown",
            expires_at: new Date(now() + answer.expiresIn * 1000).toISOString(),
          },
          ctx.env,
        );
        ctx.out(`Signed in as ${who.user ?? "unknown"} on ${server}.\n`);
        return EXIT_OK;
      }
    },
  );
}

export async function teamLink(ctx: TeamContext, opts: { server: string; org: string }): Promise<number> {
  const repo = ctx.paths.repo;
  let server: string | undefined;
  return guarded(
    ctx,
    () => ({ server, org: opts.org }),
    async () => {
      server = checkedServer(opts.server);
      if (opts.org.trim() === "") throw new GantryError("team_config", "The organisation must not be empty.");
      saveProjectConfig(ctx.paths, { team: { server, org: opts.org } });

      const linked = `Linked ${repo} to ${opts.org} on ${server}.`;
      const client = teamClient(ctx.paths, loadConfig(ctx.paths), {
        ...clientOptions(ctx),
        server,
        org: opts.org,
      });
      if (!client.hasToken) {
        ctx.out(`${linked} Run gantry team login.\n`);
        return EXIT_OK;
      }
      // The link is saved before the server is asked, so a failed check warns and never blocks (exit 0).
      try {
        const who = await client.whoami({ repo });
        ctx.out(
          who.repo_connected ? `${linked}\n` : `Linked, but ${repo} is not connected on the server yet.\n`,
        );
      } catch (err) {
        if (!(err instanceof GantryError)) throw err;
        ctx.out(`${linked}\n`);
        const warning =
          err.code === "team_unreachable"
            ? `Could not check the link: ${err.message}`
            : errorLine(err, opts.org, server);
        ctx.err(`${warning}\n`);
      }
      return EXIT_OK;
    },
  );
}

/** `126` seconds is `2 min`: whole seconds under a minute, then minutes, hours and days. */
export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86_400)} d`;
}

/** The `cache:` line of `gantry team status`; `cache: empty` before the first pull. */
function cacheLine(cache: TeamCacheSummary): string {
  if (cache.age_s === null) return "cache:     empty";
  return `cache:     ${cache.change_sets} open changes, pulled ${formatAge(cache.age_s)} ago`;
}

export async function teamStatus(
  ctx: TeamContext,
  opts: { json?: boolean; pull?: boolean },
): Promise<number> {
  const config = loadConfig(ctx.paths);
  const settings = resolveTeamSettings(config, ctx.env);
  const { server } = settings;
  const isCi = settings.token?.startsWith("gct_") === true;
  if (server === undefined || (settings.org === undefined && !isCi)) {
    ctx.err("Not linked. Run gantry team link --server <url> --org <slug>.\n");
    return EXIT_ERROR;
  }
  return guarded(
    ctx,
    () => ({ server, ...(settings.org === undefined ? {} : { org: settings.org }) }),
    async () => {
      const client: TeamClient = teamClient(ctx.paths, config, clientOptions(ctx));
      const stored = settings.token === undefined ? readCredential(server, ctx.env) : undefined;
      const repo = ctx.paths.repo;
      let org = settings.org ?? "";
      let user: string | null = stored?.user ?? null;
      let reachable = true;
      let protocol: number | null = null;
      let signedIn = client.hasToken;
      try {
        const who = await client.whoami({ repo });
        protocol = who.protocol;
        org = settings.org ?? who.org ?? org;
        user = who.user ?? (who.kind === "ci" ? "ci token" : user);
      } catch (err) {
        if (!(err instanceof GantryError)) throw err;
        if (err.code === "team_unreachable") reachable = false;
        else if (err.code === "team_unauthorized" && !client.hasToken) {
          signedIn = false; // the server answered, so it is reachable; there is just no sign-in
          protocol = client.serverProtocol();
        } else throw err;
      }
      const shownUser = signedIn ? user : null;
      // `--pull` is the one place a command asks the server for team state; a failed pull only sets `last_error`.
      if (opts.pull === true) {
        await pullTeamCache(ctx.paths, config, {
          env: ctx.env,
          ...(ctx.fetch === undefined ? {} : { fetch: ctx.fetch }),
          ...(ctx.now === undefined ? {} : { now: ctx.now }),
        });
      }
      const readonly = openTeamCache(ctx.paths, { readonly: true });
      const cache = readCacheSummary(readonly, (ctx.now ?? Date.now)());
      readonly?.close();
      if (opts.json === true) {
        ctx.out(`${JSON.stringify({ server, org, user: shownUser, repo, reachable, protocol, cache })}\n`);
      } else {
        const userText = shownUser ?? (signedIn ? "unknown" : "not signed in");
        ctx.out(
          [
            `server:    ${server}`,
            `org:       ${org}`,
            `user:      ${userText}`,
            `repo:      ${repo}`,
            `reachable: ${reachable ? "yes" : "no"}`,
            cacheLine(cache),
            "",
          ].join("\n"),
        );
      }
      return reachable && signedIn ? EXIT_OK : EXIT_ERROR;
    },
  );
}

export async function teamLogout(ctx: TeamContext, opts: { server?: string }): Promise<number> {
  return guarded(
    ctx,
    () => ({}),
    async () => {
      const server =
        opts.server === undefined
          ? resolveTeamSettings(loadConfig(ctx.paths), ctx.env).server
          : checkedServer(opts.server);
      if (server === undefined) {
        ctx.err(`${NO_SERVER}\n`);
        return EXIT_ERROR;
      }
      ctx.out(
        removeCredential(server, ctx.env) ? `Signed out of ${server}.\n` : `Not signed in on ${server}.\n`,
      );
      return EXIT_OK;
    },
  );
}

function run(body: (ctx: TeamContext) => Promise<number>): () => Promise<void> {
  return async () => {
    try {
      process.exitCode = await body({
        paths: resolveCliPaths({}),
        env: process.env,
        out: writeStdout,
        err: (text) => process.stderr.write(text),
      });
    } catch (err) {
      process.exitCode = fail(err);
    }
  };
}

export function registerTeam(program: Command): void {
  const team = program
    .command("team")
    .description("Connect this checkout to a team server (sign in, link, check the connection)");

  team
    .command("login")
    .description("Sign in to a team server with a code")
    .option("--server <url>", "the team server (default: GANTRY_SERVER, then team.server)")
    .action((opts: { server?: string }) => run((ctx) => teamLogin(ctx, opts))());

  team
    .command("link")
    .description("Say which server and organisation this repo belongs to")
    .requiredOption("--server <url>", "the team server")
    .requiredOption("--org <slug>", "the organisation slug")
    .action((opts: { server: string; org: string }) => run((ctx) => teamLink(ctx, opts))());

  team
    .command("status")
    .description(
      "Show the server, organisation, user and repo, whether the server answers, and the team cache",
    )
    .option("--json", "print one JSON line")
    .option("--pull", "pull team state from the server first")
    .action((opts: { json?: boolean; pull?: boolean }) => run((ctx) => teamStatus(ctx, opts))());

  team
    .command("logout")
    .description("Remove the stored sign-in for a server")
    .option("--server <url>", "the team server (default: GANTRY_SERVER, then team.server)")
    .action((opts: { server?: string }) => run((ctx) => teamLogout(ctx, opts))());
}

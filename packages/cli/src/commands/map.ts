import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDataDir, resolvePaths, upgradeIndexFormat } from "@gantry/core";
import { startOrReuseExplorer } from "@gantry/explorer";
import { type Command, Option } from "commander";

/** Best-effort browser launch; never throws and never keeps the process alive. */
export function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no opener available; the URL is printed anyway
  }
}

export function registerMap(program: Command): void {
  program
    .command("map")
    .description("Start the explorer server (or reuse the running one) and open it")
    .option("--port <port>", "port to bind on 127.0.0.1 (default: OS-assigned)")
    .option("--no-open", "do not open the browser")
    .addOption(
      new Option(
        "--no-url",
        "print the address without the access token (used when output goes to a log)",
      ).hideHelp(),
    )
    .addOption(
      new Option(
        "--idle-timeout <minutes>",
        "exit after this many minutes without a request (default: never)",
      )
        .argParser(Number)
        .hideHelp(),
    )
    .action(async (opts: { port?: string; open: boolean; url: boolean; idleTimeout?: number }) => {
      let port: number | undefined;
      if (opts.port !== undefined) {
        port = Number(opts.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          process.stderr.write(`Invalid --port: ${opts.port}\n`);
          process.exitCode = 1;
          return;
        }
      }
      const paths = resolvePaths(process.cwd());
      ensureDataDir(paths);
      // A store from an older index format (#195) is re-indexed in full first, so the views show adapter facts for
      // every file. Fails open: the explorer then serves the index as it is.
      try {
        const t0 = Date.now();
        if (await upgradeIndexFormat(paths))
          process.stderr.write(`gantry map: index format changed; re-indexed in ${Date.now() - t0} ms\n`);
      } catch (err) {
        process.stderr.write(
          `gantry map: re-index after a format change failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      // Bundled to plugin/dist/cli.js; the Vite build lives in plugin/dist/explorer/.
      const staticDir = join(dirname(fileURLToPath(import.meta.url)), "explorer");
      // Accepted for v1: the printed/opened URL carries `?t=<token>`, so the token is visible in process
      // arguments (`open <url>`) and browser history. The server strips it on first load and sets a cookie.
      const idleMin = opts.idleTimeout;
      if (idleMin !== undefined && (!Number.isFinite(idleMin) || idleMin <= 0)) {
        process.stderr.write(`Invalid --idle-timeout: ${idleMin}\n`);
        process.exitCode = 1;
        return;
      }
      let running: Awaited<ReturnType<typeof startOrReuseExplorer>>;
      try {
        running = await startOrReuseExplorer({
          paths,
          port,
          staticDir,
          ...(idleMin ? { idleTimeoutMs: idleMin * 60_000, onIdle: () => process.exit(0) } : {}),
        });
      } catch (err) {
        process.stderr.write(`gantry map: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
        return;
      }
      // `--no-url`: the token never reaches a log file; the URL is in explorer.json (0600) for whoever needs it.
      process.stdout.write(
        opts.url ? `${running.url}\n` : `Explorer listening on http://127.0.0.1:${running.port}/\n`,
      );
      if (opts.open) openBrowser(running.url);
      if (running.reused || !running.server) return; // the other process keeps serving

      const server = running.server;
      const stop = () => {
        void server.close().finally(() => process.exit(0));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
}

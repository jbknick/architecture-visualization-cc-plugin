import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDataDir, resolvePaths } from "@gantry/core";
import { startOrReuseExplorer } from "@gantry/explorer";
import type { Command } from "commander";

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
    .action(async (opts: { port?: string; open: boolean }) => {
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
      // Bundled to plugin/dist/cli.js; the Vite build lives in plugin/dist/explorer/.
      const staticDir = join(dirname(fileURLToPath(import.meta.url)), "explorer");
      const running = await startOrReuseExplorer({ paths, port, staticDir });
      process.stdout.write(`${running.url}\n`);
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

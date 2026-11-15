import type { Command } from "commander";
import { runHook } from "../hooks/entry.js";

/** Reads the hook input from stdin; gives up quietly after `ms` (Claude Code closes the pipe after writing). */
function readStdin(ms: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    const done = (): void => {
      clearTimeout(t);
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      process.stdin.removeAllListeners("error");
      resolve(data);
    };
    const t = setTimeout(done, ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => {
      data += c;
      if (data.length > 1024 * 1024) done();
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

export function registerHook(program: Command): void {
  program
    .command("hook")
    .description("Hook entry point called by git and Claude Code hooks; always exits 0")
    .argument(
      "<name>",
      "session-start|post-tool-use|stop|pre-commit|pre-push|post-checkout|post-merge|post-rewrite",
    )
    .argument("[args...]", "arguments git passes to the hook")
    .allowUnknownOption()
    .action(async (name: string, args: string[]) => {
      process.exitCode = 0;
      // Worker guard first: no Gantry code runs for a describer's own commits.
      if (process.env.GANTRY_WORKER === "1") return;
      try {
        const stdin = name === "post-tool-use" || name === "stop" ? await readStdin(500) : undefined;
        const line = await runHook(name, args, process.cwd(), process.env, undefined, stdin);
        if (line) process.stdout.write(`${line}\n`);
      } catch {
        // fail open
      }
      // A timed-out post-tool-use or stop may still have work in flight; do not wait for it.
      if (name === "post-tool-use" || name === "stop") process.stdout.write("", () => process.exit(0));
    });
}

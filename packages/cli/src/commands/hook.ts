import type { Command } from "commander";
import { runHook } from "../hooks/entry.js";

export function registerHook(program: Command): void {
  program
    .command("hook")
    .description("Hook entry point called by git and Claude Code hooks; always exits 0")
    .argument(
      "<name>",
      "session-start|post-tool-use|pre-commit|pre-push|post-checkout|post-merge|post-rewrite",
    )
    .argument("[args...]", "arguments git passes to the hook")
    .allowUnknownOption()
    .action(async (name: string, args: string[]) => {
      process.exitCode = 0;
      // Worker guard first: no Gantry code runs for a describer's own commits.
      if (process.env.GANTRY_WORKER === "1") return;
      try {
        const line = await runHook(name, args);
        if (line) process.stdout.write(`${line}\n`);
      } catch {
        // fail open
      }
    });
}

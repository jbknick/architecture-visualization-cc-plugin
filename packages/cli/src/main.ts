import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

// Bundled to plugin/dist/cli.js, so plugin.json is one level up.
const pluginJson = join(dirname(fileURLToPath(import.meta.url)), "..", ".claude-plugin", "plugin.json");
const { version } = JSON.parse(readFileSync(pluginJson, "utf8")) as { version: string };

const program = new Command().name("gantry").version(version);
program.parse();

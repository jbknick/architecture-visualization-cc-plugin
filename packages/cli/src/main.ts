import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerIndex } from "./commands/index.js";
import { registerInit } from "./commands/init.js";
import { registerMap } from "./commands/map.js";

// Bundled to plugin/dist/cli.js, so plugin.json is one level up.
const pluginJson = join(dirname(fileURLToPath(import.meta.url)), "..", ".claude-plugin", "plugin.json");
const { version } = JSON.parse(readFileSync(pluginJson, "utf8")) as { version: string };

const program = new Command().name("gantry").version(version);
registerInit(program);
registerIndex(program);
registerMap(program);
await program.parseAsync();

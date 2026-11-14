import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerConfig } from "./commands/config.js";
import { registerHeal } from "./commands/heal.js";
import { registerHook } from "./commands/hook.js";
import { registerHooks } from "./commands/hooks.js";
import { registerIndex } from "./commands/index.js";
import { registerInit } from "./commands/init.js";
import { registerMap } from "./commands/map.js";
import { registerNode } from "./commands/node.js";
import { registerSearch } from "./commands/search.js";
import { registerUninstall } from "./commands/uninstall.js";
import { registerUsage } from "./commands/usage.js";

// Bundled to plugin/dist/cli.js, so plugin.json is one level up.
const pluginJson = join(dirname(fileURLToPath(import.meta.url)), "..", ".claude-plugin", "plugin.json");
const { version } = JSON.parse(readFileSync(pluginJson, "utf8")) as { version: string };

const program = new Command().name("gantry").version(version);
registerInit(program);
registerHeal(program);
registerIndex(program);
registerMap(program);
registerHooks(program);
registerHook(program);
registerUninstall(program);
registerSearch(program);
registerNode(program);
registerUsage(program);
registerConfig(program);
await program.parseAsync();

import "./stdout-guard.js"; // must stay first: stdout carries protocol frames only

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// Bundled to plugin/dist/mcp.js, so plugin.json is one level up.
function pluginVersion(): string {
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), "..", ".claude-plugin", "plugin.json");
    return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const server = createServer({ version: pluginVersion() });
  await server.connect(new StdioServerTransport());
}

process.on("unhandledRejection", (err) => console.error("gantry-mcp: unhandled rejection", err));
process.on("uncaughtException", (err) => console.error("gantry-mcp: uncaught exception", err));

main().catch((err) => {
  console.error("gantry-mcp: failed to start", err);
  process.exit(1);
});

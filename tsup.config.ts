import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "packages/cli/src/main.ts",
    mcp: "packages/mcp/src/main.ts",
  },
  outDir: "plugin/dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  external: ["better-sqlite3", "sqlite-vec", "oxc-parser", "oxc-resolver"],
});

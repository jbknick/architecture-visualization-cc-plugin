import { copyFileSync } from "node:fs";
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
  // store/db.ts reads schema.sql next to the running file at runtime (new URL("./schema.sql", import.meta.url)),
  // which for the bundles is plugin/dist/. tsup does not copy it, so do it here.
  onSuccess: async () => {
    copyFileSync("packages/core/src/store/schema.sql", "plugin/dist/schema.sql");
  },
});

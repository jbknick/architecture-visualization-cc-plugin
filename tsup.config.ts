import { cpSync } from "node:fs";
import { defineConfig } from "tsup";

/** The bundles of the plugin. The e2e tests build the same entries through scripts/testBundle.ts. */
export const entry = {
  cli: "packages/cli/src/main.ts",
  mcp: "packages/mcp/src/main.ts",
  // The pull request comment script of the GitHub Action (#282); only node built-ins, so it needs no external.
  action: "action/src/main.ts",
  // The upload step of the Action: sends the main graph or a pull request's change set to a team server.
  upload: "action/src/upload-main.ts",
};

/** The headless worker reads its system prompt from <bundle dir>/prompts/ (same relative path as in the source tree). */
export function copyPrompts(outDir: string, root = "."): void {
  cpSync(`${root}/packages/core/src/describe/prompts`, `${outDir}/prompts`, { recursive: true });
}

/** Native and optional packages stay outside the bundle and resolve from node_modules at run time. */
export const external = [
  "better-sqlite3",
  "sqlite-vec",
  "oxc-parser",
  "oxc-resolver",
  "@ast-grep/napi",
  "@ast-grep/lang-csharp",
  "@ast-grep/lang-go",
  "@ast-grep/lang-java",
  "@ast-grep/lang-python",
  "@ast-grep/lang-rust",
  "@huggingface/transformers",
  "onnxruntime-node",
];

export default defineConfig({
  entry,
  outDir: "plugin/dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  onSuccess: async () => {
    copyPrompts("plugin/dist");
  },
  external,
});

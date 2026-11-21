import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// vitest 5 dropped vitest.workspace.ts; tests are discovered across packages/* from source only.
export default defineConfig({
  // The explorer's UI kit imports from "@/" (packages/explorer/web/src), as web/vite.config.ts does.
  resolve: { alias: { "@": resolve(import.meta.dirname, "packages/explorer/web/src") } },
  test: {
    // Many tests spawn git or the bundled CLI. The 5 s default fails them whenever the machine is busy
    // (several builds or suites at once); 30 s still catches a real hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: [
      "action/src/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "packages/*/server/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "packages/explorer/web/src/**/*.test.{ts,tsx}", // component tests opt into jsdom with a docblock
      "plugin/*.test.ts",
      "scripts/*.test.ts",
      "docs/spikes/**/*.test.ts",
      "evals/**/*.test.ts",
    ],
  },
});

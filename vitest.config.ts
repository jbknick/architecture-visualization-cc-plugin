import { defineConfig } from "vitest/config";

// vitest 5 dropped vitest.workspace.ts; tests are discovered across packages/* from source only.
export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/server/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "packages/explorer/web/src/**/*.test.{ts,tsx}", // component tests opt into jsdom with a docblock
      "docs/spikes/**/*.test.ts",
    ],
  },
});

import { defineConfig } from "vitest/config";

// vitest 5 dropped vitest.workspace.ts; tests are discovered across packages/* from source only.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts", "docs/spikes/**/*.test.ts"],
  },
});

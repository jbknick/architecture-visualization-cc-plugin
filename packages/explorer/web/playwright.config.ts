import { defineConfig } from "playwright/test";

// The smoke test runs the built UI against the in-repo mock API (mock/server.ts), not the real server.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4173", viewport: { width: 1440, height: 900 } },
  webServer: {
    command: "tsx mock/server.ts",
    url: "http://127.0.0.1:4173/api/meta",
    reuseExistingServer: false,
    env: { MOCK_PORT: "4173" },
  },
});

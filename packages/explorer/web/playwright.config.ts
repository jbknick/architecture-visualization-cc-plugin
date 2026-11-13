import { defineConfig } from "playwright/test";

// The smoke test runs the built UI against the in-repo mock API (mock/server.ts). The real-server spec starts
// its own `gantry map` and ignores baseURL. Set MOCK_PORT if 4173 is taken.
const port = Number(process.env.MOCK_PORT ?? 4173);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 } },
  webServer: {
    command: "tsx mock/server.ts",
    url: `http://127.0.0.1:${port}/api/meta`,
    reuseExistingServer: false,
    env: { MOCK_PORT: String(port) },
  },
});

import { defineConfig } from "playwright/test";

// `pnpm --filter @gantry/explorer perf`: opens the synthetic 30k-function graph and reports fps.
// By default Chromium uses the machine's GPU (on a Mac, through ANGLE/Metal), which is what an operator sees.
// PERF_GL=swiftshader forces software GL: reproducible anywhere, but far slower than any real GPU.
const port = process.env.MOCK_PORT ?? "4174";
const gl =
  process.env.PERF_GL !== "swiftshader"
    ? ["--use-angle=metal", "--ignore-gpu-blocklist"]
    : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

export default defineConfig({
  testDir: "./perf",
  timeout: 300_000,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: gl },
  },
  webServer: {
    command: "tsx mock/server.ts",
    url: `http://127.0.0.1:${port}/api/meta`,
    reuseExistingServer: false,
    env: { MOCK_PORT: port },
  },
});

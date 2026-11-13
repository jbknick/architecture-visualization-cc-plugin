import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

// The build lands in plugin/dist/explorer/, which `gantry map` serves. Root `pnpm build` runs tsup first
// (its clean: true wipes plugin/dist) and this build second, so the explorer output survives.
export default defineConfig({
  root: here,
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(here, "../../../plugin/dist/explorer"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1700, // the lazy 3D chunk (three.js) is ~1.5 MB; the main bundle stays small
  },
});

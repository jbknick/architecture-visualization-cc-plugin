import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "~ui": fileURLToPath(new URL("../../packages/ui/src", import.meta.url)),
    },
  },
});

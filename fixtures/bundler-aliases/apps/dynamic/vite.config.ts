import path from "node:path";
import { defineConfig } from "vite";

function makeAliases(): Record<string, string> {
  return { "@dyn": path.resolve(__dirname, "src") };
}

export default defineConfig({
  resolve: { alias: makeAliases() },
});

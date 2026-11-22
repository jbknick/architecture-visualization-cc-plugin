import { defineConfig } from "vite";

export default defineConfig(() => ({
  resolve: {
    alias: [{ find: "#lib", replacement: "/src/lib" }],
  },
}));

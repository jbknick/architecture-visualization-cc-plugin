const path = require("node:path");

module.exports = {
  entry: "./src/index.ts",
  resolve: {
    alias: {
      "@app": path.resolve(__dirname, "src/"),
      components$: path.join(__dirname, "src/components/index.ts"),
    },
  },
};

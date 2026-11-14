import path from "node:path";
import { BrowseTargetError, browse, writeCatalog } from "@gantry/core";
import { z } from "zod";
import { defineTool } from "../tool.js";
import { untrustedField } from "../untrusted.js";

export const browseTool = defineTool({
  name: "gantry_browse",
  description:
    "Lists what is one level below a workspace id (ws:...), a directory path or a file path: {items: [{id, name, kind, exported, path, line, count, untrusted_description}], catalog_path}. " +
    "Directories and files come back as items of kind dir and file with the number of functions in them; a file lists its symbols. " +
    "catalog_path is a markdown file on disk with every function of the directory and a one-line description each; Read it when you need more than the 4,000 characters a response can hold.",
  inputSchema: {
    target: z
      .string()
      .min(1)
      .max(500)
      .describe("A workspace id (ws:...) or name, a directory path or a file path"),
  },
  run({ target }, { store, paths, log }) {
    try {
      writeCatalog(store, paths); // unchanged directories are not rewritten
    } catch (err) {
      log.error("catalog write failed; browsing without a fresh catalog", err);
    }
    try {
      const r = browse(store, target);
      return {
        items: r.items.map(({ description, ...item }) => ({ ...item, ...untrustedField(description) })),
        catalog_path: path.join(paths.catalogDir, r.catalogPath),
      };
    } catch (err) {
      if (err instanceof BrowseTargetError) return { error: "not_found", message: err.message, items: [] };
      throw err;
    }
  },
});

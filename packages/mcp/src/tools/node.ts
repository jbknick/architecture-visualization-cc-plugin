import { behaviorOf, describedByOf, nodeInfo } from "@gantry/core";
import { z } from "zod";
import { defineTool } from "../tool.js";
import { describedByField, untrustedField } from "../untrusted.js";

/** Neighbors listed per edge kind; the rest are counted in `more`. */
export const NEIGHBORS_PER_KIND = 20;

export const nodeTool = defineTool({
  name: "gantry_node",
  description:
    "Looks up one symbol or file by id (sym:..., file:...), by path:line (the innermost symbol on that line) or by path. " +
    "Returns {node (with lang, the language), untrusted_description, described_by?, signature, fan_in, fan_out, neighbors, more?}: described_by says who wrote the description (model, template, or fallback: written by Gantry without a model from names only); neighbors are node ids grouped by edge kind (a kind with :in is an incoming edge), at most 20 per kind, and more gives how many were left out per kind.",
  inputSchema: {
    target: z.string().min(1).max(500).describe("sym:... or file:... id, path:line, or a file path"),
  },
  run({ target }, { store }) {
    const info = nodeInfo(store, target);
    if (!info) return { error: "not_found", message: "No symbol or file matches that target." };

    const neighbors: Record<string, string[]> = {};
    const more: Record<string, number> = {};
    for (const [kind, ids] of Object.entries(info.neighbors)) {
      neighbors[kind] = ids.slice(0, NEIGHBORS_PER_KIND);
      if (ids.length > NEIGHBORS_PER_KIND) more[kind] = ids.length - NEIGHBORS_PER_KIND;
    }
    const n = info.node;
    if ("fileId" in n) {
      const file = store.effectiveFile(n.fileId);
      return {
        node: {
          id: n.id,
          name: n.name,
          kind: n.kind,
          lang: n.lang,
          exported: n.exported,
          path: file?.path ?? null,
          line: n.startLine,
        },
        ...untrustedField(behaviorOf(store, n)),
        ...describedByField(describedByOf(store, n)),
        signature: n.signature,
        fan_in: info.fanIn,
        fan_out: info.fanOut,
        neighbors,
        ...(Object.keys(more).length > 0 ? { more } : {}),
      };
    }
    return {
      node: { id: n.id, kind: "file", lang: n.lang, path: n.path, workspace: n.workspaceId },
      ...untrustedField(null),
      signature: null,
      fan_in: info.fanIn,
      fan_out: info.fanOut,
      neighbors,
      ...(Object.keys(more).length > 0 ? { more } : {}),
    };
  },
});

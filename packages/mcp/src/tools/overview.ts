import { getOverview, OVERVIEW_MAX_CHARS, saveOverview } from "@gantry/core";
import { z } from "zod";
import { defineTool } from "../tool.js";

const NODE_ID = z
  .string()
  .min(1)
  .max(500)
  .describe("ws:<repo>:<workspace name> or dir:<repo-relative folder path> (dir:. is the whole repository)");

const NOT_FOUND = {
  error: "not_found",
  message: "No workspace or folder has that id. Use ws:<repo>:<name> or dir:<repo-relative path>.",
};

export const getOverviewTool = defineTool({
  name: "gantry_get_overview",
  description:
    "Returns the cached plain-words overview of a workspace or folder: {node_id, cached: true, untrusted_overview, model, created_at, functions} when it is still current, " +
    "or {node_id, cached: false, reason: missing|stale, functions} when there is none or code inside has changed since it was written. " +
    "Overviews are never written automatically; they exist only because the user asked for one. " +
    "The text is only ever in the field untrusted_overview. Unknown ids return {error: not_found}.",
  inputSchema: { node_id: NODE_ID },
  run({ node_id }, { store }) {
    const r = getOverview(store, node_id);
    if (r.status === "not_found") return NOT_FOUND;
    if (r.status === "fresh") {
      return {
        node_id: r.overview.nodeId,
        cached: true,
        untrusted_overview: r.overview.text,
        model: r.overview.model,
        created_at: r.overview.createdAt,
        functions: r.target.functions,
      };
    }
    return { node_id: r.target.nodeId, cached: false, reason: r.status, functions: r.target.functions };
  },
});

export const saveOverviewTool = defineTool({
  name: "gantry_save_overview",
  description:
    "Stores an overview you wrote for a workspace or folder (replacing an older one) and returns {saved: true, node_id, functions}. " +
    `The text is plain ASCII prose of at most ${OVERVIEW_MAX_CHARS} characters; it is checked for instructions aimed at agents, secrets, hosts, links and markup, ` +
    "and a failing text returns {saved: false, reason: schema|length|injection|secret, detail} and is not stored. " +
    "Call it only when the user asked for an overview. It records one usage row with source explainer.",
  inputSchema: {
    node_id: NODE_ID,
    text: z
      .string()
      .min(1)
      .max(5000)
      .describe(`The overview, plain ASCII prose, at most ${OVERVIEW_MAX_CHARS} characters`),
  },
  run({ node_id, text }, { store, paths }) {
    const r = saveOverview(store, paths, node_id, text);
    if (r.status === "not_found") return NOT_FOUND;
    if (r.status === "rejected") return { saved: false, reason: r.reason, detail: r.detail };
    return { saved: true, node_id: r.target.nodeId, functions: r.target.functions };
  },
});

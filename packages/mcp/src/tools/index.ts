import type { Tool } from "../tool.js";
import { browseTool } from "./browse.js";
import { claimTool } from "./claim.js";
import { findSimilarTool } from "./findSimilar.js";
import { impactTool } from "./impact.js";
import { nodeTool } from "./node.js";
import { openViewTool } from "./openView.js";
import { getOverviewTool, saveOverviewTool } from "./overview.js";
import { searchTool } from "./search.js";
import { submitTool } from "./submit.js";

/**
 * Every tool the server offers. A later issue adds one file in this directory that exports a `defineTool(...)`
 * result and one line here; nothing else changes (the server wraps each tool in the lazy refresh and the envelope).
 */
export const TOOLS: Tool[] = [
  claimTool,
  submitTool,
  findSimilarTool,
  searchTool,
  browseTool,
  nodeTool,
  openViewTool,
  impactTool,
  getOverviewTool,
  saveOverviewTool,
];

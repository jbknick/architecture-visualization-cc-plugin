import type { Tool } from "../tool.js";
import { claimTool } from "./claim.js";
import { submitTool } from "./submit.js";

/**
 * Every tool the server offers. A later issue adds one file in this directory that exports a `defineTool(...)`
 * result and one line here; nothing else changes (the server wraps each tool in the lazy refresh and the envelope).
 */
export const TOOLS: Tool[] = [claimTool, submitTool];

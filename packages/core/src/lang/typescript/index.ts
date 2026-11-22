import { parseSource } from "../../parse/index.js";
import { createResolver } from "../../resolve/index.js";
import type { SymbolKind } from "../../types.js";
import { detectWorkspaces } from "../../workspace/index.js";
import type { LanguageModule } from "../index.js";
import { typescriptEmbeddingText, typescriptStreams } from "./streams.js";

const KIND_LABELS: Record<SymbolKind, string> = {
  function: "function",
  method: "method",
  component: "component",
  hook: "hook",
  class: "class",
  type: "type",
  interface: "interface",
  enum: "enum",
  const: "const",
};

/** The TypeScript (and TSX) language module: oxc parser, npm workspaces, the oxc-based token walk. */
export const typescript: LanguageModule = {
  id: "typescript",
  label: "TypeScript",
  extensions: [".ts", ".tsx", ".mts", ".cts"],
  detectWorkspaces,
  manifestFiles: ["package.json"],
  unreusable: [],
  parseSource,
  createResolver,
  streams: typescriptStreams,
  embeddingText: typescriptEmbeddingText,
  factSheetHints: [],
  kindLabels: KIND_LABELS,
  thresholds: { exactMinStmts: 3, nearMinStmts: 6 },
};

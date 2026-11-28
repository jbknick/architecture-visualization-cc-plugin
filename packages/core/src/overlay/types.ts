import { z } from "zod";

/** Types of the curation overlay (spec section 7): what a person labeled, hid, grouped or saved. */
export const NodeIdSchema = z.string().min(1).max(1024);
export const GroupIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const SELECTOR_KINDS = [
  "workspace",
  "dir",
  "file",
  "function",
  "method",
  "component",
  "hook",
  "class",
  "type",
  "interface",
  "enum",
  "const",
  "route",
  "endpoint",
  "middleware",
  "table",
] as const;

export const SelectorSchema = z.discriminatedUnion("type", [
  // repo-relative posix path glob (picomatch, dot: true)
  z.object({ type: z.literal("glob"), glob: z.string().min(1).max(300) }).strict(),
  z.object({ type: z.literal("kind"), kind: z.enum(SELECTOR_KINDS) }).strict(),
  // a workspace id (`ws:...`)
  z.object({ type: z.literal("workspace"), workspace: NodeIdSchema }).strict(),
  z.object({ type: z.literal("ids"), ids: z.array(NodeIdSchema).min(1).max(500) }).strict(),
]);

export const FilterSpecSchema = z
  .object({
    view: z.string().min(1).max(50),
    level: z.enum(["workspaces", "dirs", "files", "symbols"]).optional(),
    focus: NodeIdSchema.optional(),
    /** Hidden only in this view, on top of the global hidden list. */
    hidden: z.array(SelectorSchema).max(50).default([]),
    /** Groups listed in the response; [] = all groups. */
    groups: z.array(GroupIdSchema).max(50).default([]),
    filters: z.record(z.string().max(100), z.string().max(500)).default({}),
  })
  .strict();

export const GroupSchema = z
  .object({
    id: GroupIdSchema,
    name: z.string().min(1).max(80),
    selectors: z.array(SelectorSchema).min(1).max(50),
    /** null: no boundary rule. */
    mayUse: z.array(GroupIdSchema).max(50).nullable().default(null),
  })
  .strict();

export const SavedViewSchema = z
  .object({ id: GroupIdSchema, name: z.string().min(1).max(80), spec: FilterSpecSchema })
  .strict();

/** `text` "" removes the label. */
export const LabelSchema = z.object({ nodeId: NodeIdSchema, text: z.string().max(80) }).strict();

export type Selector = z.infer<typeof SelectorSchema>;
export type FilterSpec = z.infer<typeof FilterSpecSchema>;
export type Group = z.infer<typeof GroupSchema>;
export type SavedView = z.infer<typeof SavedViewSchema>;
export type Label = z.infer<typeof LabelSchema>;

export interface OverlayState {
  labels: Label[];
  hidden: Selector[];
  groups: Group[];
  views: SavedView[];
}

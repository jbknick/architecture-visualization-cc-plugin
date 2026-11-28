import { z } from "zod";

/**
 * Wire schemas shared by the client and a team server.
 *
 * Evolution rule: request schemas are strict (`z.strictObject`, an unknown key is an error), so nothing travels by
 * accident. Response schemas are tolerant (`z.object`, an unknown key is dropped, never an error), so an older client
 * reads a newer server. A request field that a later protocol version adds is sent only when `supports` says the
 * server knows it (see `FIELD_SINCE` in `routes.ts`).
 */

/**
 * The longest string any field of the protocol allows (ids, paths and change set ids). The upload guard refuses a
 * string longer than this, so a payload that passes the schemas never trips it.
 */
export const MAX_STRING_LENGTH = 1024;

/** Limits the client must respect. The part limits are not here: the server gives them in `UploadBegun`. */
export const LIMITS = {
  workspaces: 500,
  files: 40_000,
  symbols: 250_000,
  edges: 900_000,
  adapter_nodes: 5_000,
  nodes: 5_000,
  radius: 3_000,
  links: 50,
  link_length: 300,
  descriptions: 500,
  pull_change_sets: 500,
  groups_per_repo: 100,
  views_per_repo: 100,
  /** Serialized size of one group or saved view, in bytes. */
  item_bytes: 32 * 1024,
  /** `message` of an error and `error` of an upload status, in characters. */
  message: 500,
  /** One whole upload, summed over its parts. */
  upload_gzip_bytes: 30 * 1024 * 1024,
  upload_raw_bytes: 300 * 1024 * 1024,
} as const;

const HEX32 = /^[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{40}$/;
const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export const IdSchema = z.string().min(1).max(MAX_STRING_LENGTH);
export const RepoSchema = z
  .string()
  .max(200)
  .regex(/^[^/\s]+\/[^/\s]+$/);
export const ShaSchema = z.string().regex(SHA);
export const HashSchema = z.string().regex(HEX32);
export const IsoSchema = z.iso.datetime();
/** `lang` and `kind` values: a pattern rather than a closed set, so a new language or kind needs no version bump. */
export const LangSchema = z.string().regex(NAME_PATTERN);
export const KindSchema = z.string().regex(NAME_PATTERN);
export const ContentKeySchema = z.string().regex(/^[0-9a-f]{32}:p[0-9]+$/);
const nonNegInt = z.number().int().min(0);

// ---- change set ids (the parsing helpers are in ids.ts)

const PR_ID = /^cs:pr:([^/#\s]+\/[^/#\s]+)#([1-9][0-9]*)$/;
const BRANCH_ID = /^cs:branch:([^/:\s]+\/[^/:\s]+):(.+)$/;

/** A change set id: `cs:pr:<repo>#<n>` or `cs:branch:<repo>:<name>`, at most 1,024 characters. */
export const ChangeSetIdSchema = z
  .string()
  .max(MAX_STRING_LENGTH)
  .refine((id) => PR_ID.test(id) || BRANCH_ID.test(id), { message: "not a change set id" });

// ---- main snapshot

export const WorkspaceSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(512),
  path: z.string().max(MAX_STRING_LENGTH),
});
export const FileSchema = z.strictObject({
  id: IdSchema,
  path: z.string().min(1).max(MAX_STRING_LENGTH),
  workspace: IdSchema,
  lang: LangSchema,
});
export const SymbolSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(512),
  kind: KindSchema,
  lang: LangSchema,
  path: z.string().min(1).max(MAX_STRING_LENGTH),
  workspace: IdSchema,
  line_start: z.number().int().min(1),
  line_end: z.number().int().min(1),
  exact_hash: HashSchema,
  renamed_hash: HashSchema.nullable(),
  content_key: ContentKeySchema.nullable(),
});
export const AdapterNodeSchema = z.strictObject({
  id: IdSchema,
  kind: KindSchema,
  workspace: IdSchema,
  /** One line, at most 200 characters. */
  label: z
    .string()
    .max(200)
    .regex(/^[^\r\n]*$/),
  file_id: IdSchema.nullable(),
});
export const EdgeSchema = z.strictObject({ from: IdSchema, to: IdSchema, kind: KindSchema });

export const MainSnapshotSchema = z.strictObject({
  repo: RepoSchema,
  sha: ShaSchema,
  workspaces: z.array(WorkspaceSchema).max(LIMITS.workspaces),
  files: z.array(FileSchema).max(LIMITS.files),
  symbols: z.array(SymbolSchema).max(LIMITS.symbols),
  edges: z.array(EdgeSchema).max(LIMITS.edges),
  adapter_nodes: z.array(AdapterNodeSchema).max(LIMITS.adapter_nodes),
});

// ---- change set

const radiusShape = {
  id: IdSchema,
  hop: z.number().int().min(1),
  tier: z.enum(["direct", "potential", "reachable"]),
  via_hub: z.boolean(),
};
export const RadiusEntrySchema = z.strictObject(radiusShape);
export const RadiusEntryReadSchema = z.object(radiusShape);

const changeSetShape = {
  id: ChangeSetIdSchema,
  repo: RepoSchema,
  source: z.enum(["pr", "branch"]),
  state: z.enum(["proposed", "in_progress", "in_review", "merged"]),
  /** `#<n>` for a pull request, the branch name for a branch. */
  ref: z.string().min(1).max(250),
  /** The head branch name (for a branch change set it equals `ref`). May be empty. */
  head_ref: z.string().max(250),
  base_branch: z.string().min(1).max(250),
  nodes: z.array(IdSchema).max(LIMITS.nodes),
  /** Present only when the client cut `nodes`: how many there were. */
  nodes_total: nonNegInt.optional(),
  radius: z.array(RadiusEntrySchema).max(LIMITS.radius),
  /** The hop-4-and-over entries before the cut; never less than the reachable entries sent. */
  reachable_total: nonNegInt.optional(),
  estimated: z.boolean(),
  confidence: z.number().min(0).max(1).optional(),
  owner: z.string().min(1).max(100),
  title: z.string().max(300).optional(),
  pr: z.number().int().min(1).optional(),
  head_sha: ShaSchema,
  created_at: IsoSchema,
  updated_at: IsoSchema,
  links: z.array(z.string().min(1).max(LIMITS.link_length)).max(LIMITS.links),
};

/** A change set. The id must name the same repo, and for a pull request the same number as `pr`. */
export const ChangeSetSchema = z.strictObject(changeSetShape).refine(
  (cs) => {
    const pr = PR_ID.exec(cs.id);
    const branch = BRANCH_ID.exec(cs.id);
    if (cs.source === "pr")
      return pr !== null && pr[1] === cs.repo && (cs.pr === undefined || Number(pr[2]) === cs.pr);
    return branch !== null && branch[1] === cs.repo;
  },
  { message: "the id must match source, repo and pr" },
);
/** The tolerant form, for what a server returns. */
export const ChangeSetReadSchema = z.object({
  ...changeSetShape,
  id: IdSchema,
  radius: z.array(RadiusEntryReadSchema),
});

// ---- descriptions

export const DescriptionSchema = z.strictObject({
  content_key: ContentKeySchema,
  behavior: z.string().max(400),
  search_terms: z.array(z.string().min(1).max(60)).min(1).max(6),
  name_fits: z.boolean(),
  suggested_name: z
    .string()
    .max(80)
    .regex(/^[A-Za-z_$][\w$]*$/)
    .optional(),
  provenance: z.enum(["model", "fallback"]),
  model: z.string().max(100).nullable(),
  prompt_version: z.string().regex(/^p[0-9]+$/),
  created_at: IsoSchema,
});

// ---- overlay (filters, groups, saved views), re-declared so the package needs nothing else

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
export const GroupIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

function buildOverlay(strict: boolean) {
  const obj = (strict ? z.strictObject : z.object) as typeof z.object;
  const selector = z.discriminatedUnion("type", [
    obj({ type: z.literal("glob"), glob: z.string().min(1).max(300) }),
    obj({ type: z.literal("kind"), kind: z.enum(SELECTOR_KINDS) }),
    obj({ type: z.literal("workspace"), workspace: IdSchema }),
    obj({ type: z.literal("ids"), ids: z.array(IdSchema).min(1).max(500) }),
  ]);
  const filterSpec = obj({
    view: z.string().min(1).max(50),
    level: z.enum(["workspaces", "dirs", "files", "symbols"]).optional(),
    focus: IdSchema.optional(),
    hidden: z.array(selector).max(50).default([]),
    groups: z.array(GroupIdSchema).max(50).default([]),
    filters: z.record(z.string().max(100), z.string().max(500)).default({}),
  });
  const group = obj({
    id: GroupIdSchema,
    name: z.string().min(1).max(80),
    selectors: z.array(selector).min(1).max(50),
    /** null: no boundary rule. */
    mayUse: z.array(GroupIdSchema).max(50).nullable().default(null),
  });
  const savedView = obj({ id: GroupIdSchema, name: z.string().min(1).max(80), spec: filterSpec });
  return { selector, filterSpec, group, savedView };
}
const strictOverlay = buildOverlay(true);
const readOverlay = buildOverlay(false);

export const SelectorSchema = strictOverlay.selector;
export const FilterSpecSchema = strictOverlay.filterSpec;
export const GroupSchema = strictOverlay.group;
export const SavedViewSchema = strictOverlay.savedView;
export const GroupReadSchema = readOverlay.group;
export const SavedViewReadSchema = readOverlay.savedView;

// ---- uploads

export const MainCountsSchema = z.strictObject({
  workspaces: z.number().int().min(0).max(LIMITS.workspaces),
  files: z.number().int().min(0).max(LIMITS.files),
  symbols: z.number().int().min(0).max(LIMITS.symbols),
  edges: z.number().int().min(0).max(LIMITS.edges),
  adapter_nodes: z.number().int().min(0).max(LIMITS.adapter_nodes),
});
export const ChangeSetCountsSchema = z.strictObject({
  nodes: z.number().int().min(0).max(LIMITS.nodes),
  radius: z.number().int().min(0).max(LIMITS.radius),
});

/** Begins an upload: counts only. The number of parts is not sent; the client sends it with every part. */
export const UploadStartSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("main"), sha: ShaSchema, counts: MainCountsSchema }),
  z.strictObject({ kind: z.literal("change_set"), counts: ChangeSetCountsSchema }),
]);

// The records of a part: one NDJSON line each, tagged by `t`.
const { nodes: _nodes, radius: _radius, repo: _repo, ...changeSetHeaderShape } = changeSetShape;
export const MainRecordSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("w"), ...WorkspaceSchema.shape }),
  z.strictObject({ t: z.literal("f"), ...FileSchema.shape }),
  z.strictObject({ t: z.literal("s"), ...SymbolSchema.shape }),
  z.strictObject({ t: z.literal("e"), ...EdgeSchema.shape }),
  z.strictObject({ t: z.literal("a"), ...AdapterNodeSchema.shape }),
]);
export const ChangeSetRecordSchema = z.discriminatedUnion("t", [
  // exactly one, the first line of part 1; its id is the upload's target
  z.strictObject({ t: z.literal("c"), ...changeSetHeaderShape }),
  z.strictObject({ t: z.literal("n"), id: IdSchema }),
  z.strictObject({ t: z.literal("r"), ...radiusShape }),
]);
export const PartRecordSchema = z.discriminatedUnion("t", [
  ...MainRecordSchema.options,
  ...ChangeSetRecordSchema.options,
]);

export const CloseRequestSchema = z
  .strictObject({ merged: z.boolean(), head_sha: ShaSchema.optional() })
  .refine((c) => !c.merged || c.head_sha !== undefined, {
    message: "head_sha is required when merged is true",
    path: ["head_sha"],
  });

export const DescriptionsRequestSchema = z.strictObject({
  repo: RepoSchema,
  descriptions: z.array(DescriptionSchema).max(LIMITS.descriptions),
});

export const DescriptionLookupRequestSchema = z.strictObject({
  repo: RepoSchema,
  content_keys: z.array(ContentKeySchema).min(1).max(LIMITS.descriptions),
});

// ---- responses (tolerant)

export const UploadBegunSchema = z.object({
  upload_id: z.string().regex(/^[0-9a-f]{24}$/),
  part_max_records: z.number().int().min(1),
  part_max_bytes: z.number().int().min(1),
  max_parts: z.number().int().min(1),
});
export const UploadPartResponseSchema = z.object({
  upload_id: z.string(),
  part: z.number().int().min(1),
  status: z.enum(["queued", "loading", "done"]),
});
export const UploadStatusSchema = z.object({
  status: z.enum(["queued", "loading", "done", "failed", "superseded"]),
  error: z.string().max(LIMITS.message).optional(),
  parts: z.object({
    total: nonNegInt,
    received: nonNegInt,
    done: nonNegInt,
    failed: nonNegInt,
  }),
});
export const CloseResponseSchema = z.object({ closed: z.boolean() });
export const PullResponseSchema = z.object({
  change_sets: z.array(ChangeSetReadSchema),
  team_views: z.array(SavedViewReadSchema),
  groups: z.array(GroupReadSchema),
  settings: z.object({ default_view: z.string().optional() }),
  next_cursor: z.string().optional(),
  pulled_at: z.string(),
});
export const DescriptionsResponseSchema = z.object({ stored: nonNegInt });

/**
 * The shape of a `Description` for reading: the same fields and checks, but a key this version does not know is
 * dropped instead of failing the record (`DescriptionSchema` is strict, for what a client sends).
 */
export const DescriptionReadSchema = z.object(DescriptionSchema.shape);

/**
 * What the lookup returns: the descriptions the organization has, whatever the repo. A key with none is absent. The
 * records are `unknown` here on purpose: one record that does not fit must not reject the others, so the caller
 * checks each with `DescriptionReadSchema.safeParse` and drops the ones that fail.
 */
export const DescriptionLookupResponseSchema = z.object({ descriptions: z.array(z.unknown()) });
export const SavedResponseSchema = z.object({ saved: z.literal(true) });
export const DeletedResponseSchema = z.object({ deleted: z.boolean() });
export const WhoamiResponseSchema = z.object({
  kind: z.enum(["ci", "user"]),
  org: z.string().optional(),
  user: z.string().optional(),
  role: z.enum(["owner", "admin", "member"]).optional(),
  repo: z.string().optional(),
  repo_connected: z.boolean(),
  protocol: z.number().int().min(1),
});

/** `budget` (409): the server's daily upload capacity is used. The client stops and tries again later. */
export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid",
  "too_large",
  "conflict",
  "budget",
  "protocol_version",
] as const;
export const ErrorSchema = z.object({
  error: z.enum(ERROR_CODES),
  message: z.string().max(LIMITS.message),
});

/** Device sign-in answers (outside `/v1`; not in `ROUTES`). */
export const DeviceCodeResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  /** Optional in RFC 8628: the verification URL with the user code already in it. */
  verification_uri_complete: z.string().optional(),
  expires_in: z.number().int(),
  interval: z.number().int(),
});
export const DeviceTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number().int(),
});

export type MainSnapshot = z.infer<typeof MainSnapshotSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type FileNode = z.infer<typeof FileSchema>;
export type SymbolNode = z.infer<typeof SymbolSchema>;
export type AdapterNode = z.infer<typeof AdapterNodeSchema>;
export type Edge = z.infer<typeof EdgeSchema>;
export type RadiusEntry = z.infer<typeof RadiusEntrySchema>;
export type ChangeSet = z.infer<typeof ChangeSetSchema>;
export type ChangeSetRead = z.infer<typeof ChangeSetReadSchema>;
export type Description = z.infer<typeof DescriptionSchema>;
export type Selector = z.infer<typeof SelectorSchema>;
export type FilterSpec = z.infer<typeof FilterSpecSchema>;
export type Group = z.infer<typeof GroupSchema>;
export type SavedView = z.infer<typeof SavedViewSchema>;
export type UploadStart = z.infer<typeof UploadStartSchema>;
export type MainRecord = z.infer<typeof MainRecordSchema>;
export type ChangeSetRecord = z.infer<typeof ChangeSetRecordSchema>;
export type PartRecord = z.infer<typeof PartRecordSchema>;
export type CloseRequest = z.infer<typeof CloseRequestSchema>;
export type DescriptionLookupRequest = z.infer<typeof DescriptionLookupRequestSchema>;
export type DescriptionLookupResponse = z.infer<typeof DescriptionLookupResponseSchema>;
export type DescriptionRead = z.infer<typeof DescriptionReadSchema>;
export type DescriptionsRequest = z.infer<typeof DescriptionsRequestSchema>;
export type UploadBegun = z.infer<typeof UploadBegunSchema>;
export type UploadPartResponse = z.infer<typeof UploadPartResponseSchema>;
export type UploadStatus = z.infer<typeof UploadStatusSchema>;
export type CloseResponse = z.infer<typeof CloseResponseSchema>;
export type PullResponse = z.infer<typeof PullResponseSchema>;
export type WhoamiResponse = z.infer<typeof WhoamiResponseSchema>;
export type ErrorCode = (typeof ERROR_CODES)[number];
export type ErrorBody = z.infer<typeof ErrorSchema>;

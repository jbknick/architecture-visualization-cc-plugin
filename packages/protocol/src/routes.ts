import { z } from "zod";
import {
  CloseRequestSchema,
  CloseResponseSchema,
  DeletedResponseSchema,
  DescriptionLookupRequestSchema,
  DescriptionLookupResponseSchema,
  DescriptionsRequestSchema,
  DescriptionsResponseSchema,
  type ErrorCode,
  GroupSchema,
  PullResponseSchema,
  SavedResponseSchema,
  SavedViewSchema,
  UploadBegunSchema,
  UploadPartResponseSchema,
  UploadStartSchema,
  UploadStatusSchema,
  WhoamiResponseSchema,
} from "./schemas.js";

/** The wire protocol version this package speaks. Sent as `X-Gantry-Protocol`. */
export const PROTOCOL_VERSION = 2;

export const HEADER_PROTOCOL = "X-Gantry-Protocol";
/** On every response: the highest protocol version the server supports. */
export const HEADER_PROTOCOL_MAX = "X-Gantry-Protocol-Max";
/** A user token names its organisation with this header. */
export const HEADER_ORG = "X-Gantry-Org";
/** On `POST /v1/repos/:repo/uploads`: `main` or the change set id, percent-encoded (see `encodeTarget`). */
export const HEADER_TARGET = "X-Gantry-Target";
/** On every part: the number of parts the client cut the upload into. */
export const HEADER_PART_COUNT = "X-Gantry-Part-Count";
/** On the last page of a pull, when the list of change sets was cut. */
export const HEADER_TRUNCATED = "X-Gantry-Truncated";

/**
 * Maps a request field or route key to the protocol version that introduced it. A route key is its method and path,
 * for example `POST /v1/descriptions/lookup`. A later change that adds a request field or a route bumps
 * `PROTOCOL_VERSION` by one and adds its keys here.
 */
export const FIELD_SINCE: Record<string, number> = {
  "POST /v1/descriptions/lookup": 2,
};

/**
 * Whether a client may send `key` to a server whose highest version is `serverMax`. An unknown `serverMax` counts as
 * 1, and a key that is not in `FIELD_SINCE` counts as introduced at version 1.
 */
export function supports(serverMax: number | undefined, key: string): boolean {
  return (FIELD_SINCE[key] ?? 1) <= (serverMax ?? 1);
}

export type AuthKind = "ci" | "user";

export interface RouteDef {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path template; `:name` segments are filled by `buildPath`. */
  path: string;
  /** The kinds of bearer token the route takes. */
  auth: readonly AuthKind[];
  /** Query parameters, or null. */
  query: z.ZodType | null;
  /** The JSON body, or null for no body (a part's body is gzipped NDJSON, see `splitIntoParts`). */
  request: z.ZodType | null;
  response: z.ZodType;
  /** The error codes the route can answer, besides `protocol_version`. */
  errors: readonly ErrorCode[];
}

const whoamiQuery = z.object({ repo: z.string().optional() });
const pullQuery = z.object({ repo: z.string(), cursor: z.string().optional() });

export const ROUTES = {
  whoami: {
    method: "GET",
    path: "/v1/whoami",
    auth: ["ci", "user"],
    query: whoamiQuery,
    request: null,
    response: WhoamiResponseSchema,
    errors: ["unauthorized", "forbidden"],
  },
  beginUpload: {
    method: "POST",
    path: "/v1/repos/:repo/uploads",
    auth: ["ci"],
    query: null,
    request: UploadStartSchema,
    response: UploadBegunSchema,
    errors: ["invalid", "unauthorized", "forbidden"],
  },
  putPart: {
    method: "PUT",
    path: "/v1/uploads/:id/parts/:n",
    auth: ["ci"],
    query: null,
    request: null,
    response: UploadPartResponseSchema,
    errors: ["invalid", "unauthorized", "forbidden", "not_found", "conflict", "budget", "too_large"],
  },
  uploadStatus: {
    method: "GET",
    path: "/v1/uploads/:id",
    auth: ["ci"],
    query: null,
    request: null,
    response: UploadStatusSchema,
    errors: ["unauthorized", "forbidden", "not_found"],
  },
  closeChangeSet: {
    method: "POST",
    path: "/v1/repos/:repo/change-sets/:id/close",
    auth: ["ci"],
    query: null,
    request: CloseRequestSchema,
    response: CloseResponseSchema,
    errors: ["invalid", "unauthorized", "forbidden"],
  },
  pull: {
    method: "GET",
    path: "/v1/pull",
    auth: ["ci", "user"],
    query: pullQuery,
    request: null,
    response: PullResponseSchema,
    errors: ["invalid", "unauthorized", "forbidden", "not_found"],
  },
  putDescriptions: {
    method: "POST",
    path: "/v1/descriptions",
    auth: ["user"],
    query: null,
    request: DescriptionsRequestSchema,
    response: DescriptionsResponseSchema,
    errors: ["invalid", "unauthorized", "forbidden", "not_found"],
  },
  lookupDescriptions: {
    method: "POST",
    path: "/v1/descriptions/lookup",
    auth: ["user"],
    query: null,
    request: DescriptionLookupRequestSchema,
    response: DescriptionLookupResponseSchema,
    errors: ["invalid", "unauthorized", "forbidden", "not_found"],
  },
  putGroup: {
    method: "PUT",
    path: "/v1/repos/:repo/groups/:id",
    auth: ["user"],
    query: null,
    request: GroupSchema,
    response: SavedResponseSchema,
    errors: ["invalid", "unauthorized", "forbidden", "not_found", "conflict", "too_large"],
  },
  deleteGroup: {
    method: "DELETE",
    path: "/v1/repos/:repo/groups/:id",
    auth: ["user"],
    query: null,
    request: null,
    response: DeletedResponseSchema,
    errors: ["unauthorized", "forbidden", "not_found"],
  },
  putView: {
    method: "PUT",
    path: "/v1/repos/:repo/views/:id",
    auth: ["user"],
    query: null,
    request: SavedViewSchema,
    response: SavedResponseSchema,
    errors: ["invalid", "unauthorized", "forbidden", "not_found", "conflict", "too_large"],
  },
  deleteView: {
    method: "DELETE",
    path: "/v1/repos/:repo/views/:id",
    auth: ["user"],
    query: null,
    request: null,
    response: DeletedResponseSchema,
    errors: ["unauthorized", "forbidden", "not_found"],
  },
} as const satisfies Record<string, RouteDef>;

/**
 * Fills a path template, URL-encoding every parameter with `encodeURIComponent`: a repo `acme/shop` becomes
 * `acme%2Fshop` and the change set id `cs:pr:acme/shop#12` becomes `cs%3Apr%3Aacme%2Fshop%2312`. Throws when a
 * parameter is missing.
 */
export function buildPath(
  route: Pick<RouteDef, "path">,
  params: Readonly<Record<string, string | number>> = {},
): string {
  return route.path.replace(/:([a-z]+)/g, (_m, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`buildPath: missing parameter :${name} for ${route.path}`);
    return encodeURIComponent(String(value));
  });
}

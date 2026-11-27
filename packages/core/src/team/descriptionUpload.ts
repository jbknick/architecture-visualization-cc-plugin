import { type Description, DescriptionSchema, DescriptionsRequestSchema, LIMITS } from "@gantry/protocol";
import { GantryError } from "../errors.js";
import type { Store } from "../store/index.js";

/**
 * The descriptions a developer's agent wrote on this machine, as the wire `Description` records of spec section 20,
 * sent to the team so another machine need not write them again. Only rows written by a model go: a `fallback` or
 * `template` row is rebuilt from the index on every machine. A description is text about code, never code: this file
 * reads the `descriptions` table and nothing else (no fact sheet, no signature, no source), and the protocol schema
 * is strict, so a field added by mistake fails the parse. Nothing here is imported by a hook.
 */

interface Row {
  content_key: string;
  behavior: string;
  search_terms: string;
  name_fits: number;
  suggested_name: string | null;
  provenance: string;
  model: string;
  prompt_version: string;
  created_at: string;
}

/** The part of the team client this module needs: send one serialised request body. */
export interface DescriptionsClient {
  putDescriptions(body: unknown): Promise<{ stored: number }>;
}

export interface DescriptionUploadOptions {
  /**
   * The `team.upload.descriptions` switch, read by the caller from the machine's config. Required, so no caller can
   * forget it: when false this function throws before it reads the table or makes a request.
   */
  enabled: boolean;
  /**
   * Writes one request body. The command passes `serialiseBody("descriptions", ...)` so the bytes a dry run shows are
   * the bytes sent; the default checks the payload with the route's schema and writes compact JSON.
   */
  serialise?: (payload: { repo: string; descriptions: Description[] }) => string;
  /** Called after each batch the server answered, with the totals so far (a later batch may still fail). */
  onBatch?: (sent: number, stored: number) => void;
}

export interface DescriptionUploadResult {
  sent: number;
  stored: number;
  /** Rows the wire schema would refuse (not sent, never silent: the caller prints the count). */
  skipped: number;
}

function toWire(row: Row): unknown {
  let terms: unknown;
  try {
    terms = JSON.parse(row.search_terms);
  } catch {
    terms = undefined;
  }
  return {
    content_key: row.content_key,
    behavior: row.behavior,
    search_terms: terms,
    name_fits: row.name_fits === 1,
    ...(row.suggested_name === null ? {} : { suggested_name: row.suggested_name }),
    provenance: row.provenance,
    model: row.model,
    prompt_version: row.prompt_version,
    created_at: row.created_at,
  };
}

/** Every model-written row of the local table as a wire record, in `content_key` order. */
export function descriptionRecords(store: Store): { records: Description[]; skipped: number } {
  const rows = store.db
    .prepare(
      `SELECT content_key, behavior, search_terms, name_fits, suggested_name, provenance, model, prompt_version, created_at
         FROM descriptions WHERE provenance = 'model' AND model IS NOT NULL ORDER BY content_key`,
    )
    .all() as Row[];
  const records: Description[] = [];
  let skipped = 0;
  for (const row of rows) {
    const parsed = DescriptionSchema.safeParse(toWire(row));
    if (parsed.success) records.push(parsed.data);
    else skipped += 1;
  }
  return { records, skipped };
}

const compact = (payload: { repo: string; descriptions: Description[] }): string =>
  JSON.stringify(DescriptionsRequestSchema.parse(payload));

/** Sends the model-written descriptions in batches of 500; `stored` is the sum of the server's answers. */
export async function uploadDescriptions(
  store: Store,
  client: DescriptionsClient,
  repo: string,
  opts: DescriptionUploadOptions,
): Promise<DescriptionUploadResult> {
  if (opts.enabled !== true) {
    throw new GantryError("team_config", "Description upload is switched off (team.upload.descriptions).");
  }
  const serialise = opts.serialise ?? compact;
  const { records, skipped } = descriptionRecords(store);
  let stored = 0;
  for (let i = 0; i < records.length; i += LIMITS.descriptions) {
    const answer = await client.putDescriptions(
      serialise({ repo, descriptions: records.slice(i, i + LIMITS.descriptions) }),
    );
    stored += answer.stored;
    opts.onBatch?.(Math.min(i + LIMITS.descriptions, records.length), stored);
  }
  return { sent: records.length, stored, skipped };
}

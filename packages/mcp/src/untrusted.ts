// Descriptions are model-written and only hardened, not guaranteed free of instructions (spec section 8). A tool that
// returns one puts it in this field and nowhere else in the response, never in its own description or in prose
// around it, so the client can tell data from instructions.

export const UNTRUSTED_FIELD = "untrusted_description";

/** `{ untrusted_description: <description> }`, for spreading into a result object. */
export function untrustedField<T>(description: T): { untrusted_description: T } {
  return { [UNTRUSTED_FIELD]: description } as { untrusted_description: T };
}

/**
 * `{ described_by }` when a description exists (#175): `model`, `template` or `fallback` (written by Gantry without a
 * model). A fixed value from the store's provenance column, never description text, so it sits outside the untrusted
 * field; the fallback marker inside the text can be imitated, this field cannot.
 */
export function describedByField(by: "model" | "template" | "fallback" | null): {
  described_by?: "model" | "template" | "fallback";
} {
  return by === null ? {} : { described_by: by };
}

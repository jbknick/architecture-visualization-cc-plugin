// Descriptions are model-written and only hardened, not guaranteed free of instructions (spec section 8). A tool that
// returns one puts it in this field and nowhere else in the response, never in its own description or in prose
// around it, so the client can tell data from instructions.

export const UNTRUSTED_FIELD = "untrusted_description";

/** `{ untrusted_description: <description> }`, for spreading into a result object. */
export function untrustedField<T>(description: T): { untrusted_description: T } {
  return { [UNTRUSTED_FIELD]: description } as { untrusted_description: T };
}

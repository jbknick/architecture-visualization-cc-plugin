import type { DescribedBy } from "./api.ts";

/**
 * The label above a stored description, by who wrote it (#180). The label is a fixed string chosen from the provenance
 * column; the description text next to it is untrusted and is rendered as plain text. A template description is
 * copied from the code and can be written by an attacker; a fallback is generated without a model from the symbol's
 * kind, parameter count and call count.
 */
export function descriptionLabel(by: DescribedBy | undefined): string {
  switch (by) {
    case "fallback":
      return "Generated without a model from the kind, parameter count and call count — may be incomplete";
    case "template":
      return "Template text copied from the code — may be wrong";
    default:
      return "Generated description — may be wrong";
  }
}

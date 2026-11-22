import { add } from "#lib/math";
import { clamp } from "#lib/range";

export const total = clamp(add(1, 2), 0, 2);

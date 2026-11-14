import type { Filters } from "../api.ts";

/** Read a boolean filter; `fallback` is the server default when the key is absent. */
export function getBool(filters: Filters, key: string, fallback: boolean): boolean {
  const v = filters[key];
  if (v === undefined) return fallback;
  return !(v === "false" || v === "0" || v === "");
}

/** Write a boolean filter. A value equal to the server default is dropped so the URL stays short. */
export function setBool(filters: Filters, key: string, value: boolean, fallback: boolean): Filters {
  const next = { ...filters };
  if (value === fallback) delete next[key];
  else next[key] = String(value);
  return next;
}

/** A `|`-separated list filter, or `undefined` when the key is absent. */
export function getList(filters: Filters, key: string): string[] | undefined {
  const v = filters[key];
  return v === undefined ? undefined : v.split("|").filter(Boolean);
}

/** Write a list filter. A list equal to `defaults` (as a set) is dropped. */
export function setList(filters: Filters, key: string, values: string[], defaults: string[]): Filters {
  const next = { ...filters };
  const same = values.length === defaults.length && defaults.every((d) => values.includes(d));
  if (same) delete next[key];
  else next[key] = values.join("|");
  return next;
}

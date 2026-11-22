export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

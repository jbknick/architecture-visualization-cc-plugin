export function computeRetryDelay(attempt: number, baseMs: number, capMs: number): number {
  const exponent = Math.min(attempt, 10);
  const raw = baseMs * 2 ** exponent;
  const capped = Math.min(raw, capMs);
  const jitter = Math.floor(capped / 4);
  return capped - jitter;
}

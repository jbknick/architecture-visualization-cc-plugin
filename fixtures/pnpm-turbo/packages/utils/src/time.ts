// Misleading name: despite "parse", this is the same logic as formatRelativeDate.
export function parseTimestamp(value: Date, current: Date = new Date()): string {
  const delta = current.getTime() - value.getTime();
  const secs = Math.floor(delta / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  const dys = Math.floor(hrs / 24);
  if (dys > 0) return `${dys}d ago`;
  if (hrs > 0) return `${hrs}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

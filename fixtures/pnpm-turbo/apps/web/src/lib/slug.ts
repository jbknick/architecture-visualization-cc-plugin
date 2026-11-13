export function slugify(input: string): string {
  const lower = input.toLowerCase();
  const trimmed = lower.trim();
  const dashed = trimmed.replace(/\s+/g, "-");
  const clean = dashed.replace(/[^a-z0-9-]/g, "");
  const collapsed = clean.replace(/-+/g, "-");
  return collapsed.replace(/^-|-$/g, "");
}

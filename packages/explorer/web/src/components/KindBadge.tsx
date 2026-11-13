export function KindBadge({ kind }: { kind: string }) {
  // The color lives in CSS (--kind-*, written from theme.ts). The label carries the meaning.
  return (
    <span className="kind-badge">
      <span
        className="kind-dot"
        style={{ background: `var(--kind-${kind}, var(--muted))` }}
        aria-hidden="true"
      />
      {kind}
    </span>
  );
}

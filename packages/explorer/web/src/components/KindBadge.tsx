import { Badge } from "./ui/badge.tsx";

export function KindBadge({ kind }: { kind: string }) {
  // The color lives in CSS (--kind-*, written from theme.ts). The label carries the meaning.
  return (
    <Badge variant="ghost" className="kind-badge h-auto gap-1.5 px-0 py-0 font-normal text-muted-foreground">
      <span
        className="kind-dot"
        style={{ background: `var(--kind-${kind}, var(--muted))` }}
        aria-hidden="true"
      />
      {kind}
    </Badge>
  );
}

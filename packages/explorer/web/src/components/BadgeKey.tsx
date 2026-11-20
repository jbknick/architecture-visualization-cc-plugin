import { M2_BADGES } from "../badges.ts";
import { currentScheme } from "../theme.ts";
import { Badge } from "./ui/badge.tsx";

/** The legend for the M2 marks on function tiles and rows. Each entry has a tooltip with the full meaning. */
export function BadgeKey({ className = "" }: { className?: string }) {
  const scheme = currentScheme();
  return (
    <ul className={`badge-key ${className}`.trim()} aria-label="Function badges" data-testid="badge-key">
      {M2_BADGES.map((b) => {
        const colour = b.colour[scheme === "dark" ? 1 : 0];
        return (
          <li key={b.name} title={b.help}>
            <Badge
              variant="outline"
              className="h-auto cursor-help gap-1.5 px-1.5 py-0 font-normal text-muted-foreground"
            >
              <span
                className="badge-dot"
                aria-hidden="true"
                style={b.hollow ? { border: `2px solid ${colour}` } : { background: colour }}
              />
              {b.label}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

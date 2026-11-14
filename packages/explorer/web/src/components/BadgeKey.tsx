import { M2_BADGES } from "../badges.ts";
import { currentScheme } from "../theme.ts";

/** The legend for the M2 marks on function tiles and rows. Each entry has a tooltip with the full meaning. */
export function BadgeKey({ className = "" }: { className?: string }) {
  const scheme = currentScheme();
  return (
    <ul className={`badge-key ${className}`.trim()} aria-label="Function badges" data-testid="badge-key">
      {M2_BADGES.map((b) => {
        const colour = b.colour[scheme === "dark" ? 1 : 0];
        return (
          <li key={b.name} title={b.help}>
            <span
              className="badge-dot"
              aria-hidden="true"
              style={b.hollow ? { border: `2px solid ${colour}` } : { background: colour }}
            />
            {b.label}
          </li>
        );
      })}
    </ul>
  );
}

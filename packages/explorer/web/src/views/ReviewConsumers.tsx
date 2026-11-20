import { Layers01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReviewConsumer, ReviewConsumers } from "../api.ts";
import {
  CROSSING_WORDS,
  DIRECT_HEADING,
  groupByFile,
  POTENTIAL_HEADING,
  shortName,
  USE_WORDS,
} from "./reviewModel.ts";

/** How a consumer uses the change, in words: `renders, other workspace` or `hop 2 via HomePage, calls`. */
export function consumerMeta(c: ReviewConsumer): string {
  const parts: string[] = [];
  if (c.via !== undefined) parts.push(`hop ${c.hop} via ${shortName(c.via)}`);
  parts.push(c.uses.map((u) => USE_WORDS[u] ?? u).join(", "));
  for (const x of c.crosses) parts.push((CROSSING_WORDS[x] ?? x).toLowerCase());
  return parts.join(" · ");
}

function Tier({
  title,
  tier,
  list,
  total,
  sel,
  onPick,
}: {
  title: string;
  tier: "direct" | "potential";
  list: ReviewConsumer[];
  total: number;
  sel: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <div className={`rv-consumer-${tier}`} data-tier={tier}>
      <h4>
        <HugeiconsIcon icon={Layers01Icon} size={12} aria-hidden="true" className="mr-1 inline-block" />
        {title} ({total})
      </h4>
      {list.length === 0 ? (
        <p className="muted">None in the index.</p>
      ) : (
        groupByFile(list).map((g) => (
          <div key={g.path} className="rv-consumer-group">
            <p className="rv-consumer-file" title={g.path}>
              {g.path || "(no file)"}
            </p>
            <ul className="rv-list">
              {g.items.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={`rv-item rv-consumer${sel === c.id ? " is-current" : ""}`}
                    aria-current={sel === c.id ? "true" : undefined}
                    data-consumer={c.id}
                    title={c.line !== null ? `${c.path}:${c.line}` : c.id}
                    onClick={() => onPick(c.id)}
                  >
                    <span className="rv-item-name">
                      {c.name} <span className="muted">({c.kind})</span>
                    </span>
                    <span className="rv-item-meta">{consumerMeta(c)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {total > list.length && (
        <p className="muted rv-more">
          and {total - list.length} more (all of them in <code>gantry review --json</code>)
        </p>
      )}
    </div>
  );
}

/**
 * The consumers of one change in two tiers: "Directly affected" (they use the changed item itself) and "Potentially
 * affected" (they use a direct consumer, hops 2 and 3), each grouped by file with how it uses it. Picking one selects
 * it; the map zooms to the node that shows it.
 */
export function ConsumerTiers({
  consumers,
  label,
  sel,
  onPick,
}: {
  consumers: ReviewConsumers;
  label: string;
  sel: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <section className="rv-consumers" aria-label={label} data-testid="review-consumers">
      <Tier
        title={DIRECT_HEADING}
        tier="direct"
        list={consumers.direct}
        total={consumers.directTotal}
        sel={sel}
        onPick={onPick}
      />
      <Tier
        title={POTENTIAL_HEADING}
        tier="potential"
        list={consumers.potential}
        total={consumers.potentialTotal}
        sel={sel}
        onPick={onPick}
      />
    </section>
  );
}

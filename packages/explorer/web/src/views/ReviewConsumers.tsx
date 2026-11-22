import { ArrowDown01Icon, ArrowRight01Icon, Layers01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReviewConsumer, ReviewConsumers, ReviewHub } from "../api.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible.tsx";
import {
  CROSSING_WORDS,
  DIRECT_HEADING,
  groupByFile,
  POTENTIAL_HEADING,
  REACHABLE_HEADING,
  REACHABLE_RING,
  shortName,
  USE_WORDS,
} from "./reviewModel.ts";

/**
 * How a consumer uses the change, in words: `renders, other workspace` or `hop 2 via HomePage, calls`. A reachable
 * consumer names the node it uses (`next`), a potential one the direct consumer it goes through.
 */
export function consumerMeta(c: ReviewConsumer): string {
  const parts: string[] = [];
  const via = c.via ?? c.next;
  if (via !== undefined) parts.push(`hop ${c.hop} via ${shortName(via)}`);
  parts.push(c.uses.map((u) => USE_WORDS[u] ?? u).join(", "));
  for (const x of c.crosses) parts.push((CROSSING_WORDS[x] ?? x).toLowerCase());
  return parts.join(" · ");
}

const hubTotal = (hubs: readonly ReviewHub[], pick: (h: ReviewHub) => boolean): number =>
  hubs.filter(pick).reduce((n, h) => n + h.consumersTotal, 0);

function ConsumerRow({
  c,
  sel,
  onPick,
}: {
  c: ReviewConsumer;
  sel: string | null;
  onPick: (id: string) => void;
}) {
  return (
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
  );
}

/** One hub: a row that opens to its consumers, grouped by workspace in the order of `byWorkspace`. */
function HubRow({ hub, sel, onPick }: { hub: ReviewHub; sel: string | null; onPick: (id: string) => void }) {
  return (
    <Collapsible className="rv-hub-row" data-hub={hub.hub}>
      <CollapsibleTrigger
        className="rv-item rv-hub-trigger"
        render={(props, state) => (
          <button type="button" {...props}>
            <HugeiconsIcon
              icon={state.open ? ArrowDown01Icon : ArrowRight01Icon}
              size={12}
              aria-hidden="true"
              className="mr-1 inline-block"
            />
            <span className="rv-item-name">
              {hub.name} · {hub.consumersTotal} consumers
            </span>
          </button>
        )}
      />
      <CollapsibleContent className="rv-hub-members">
        {hub.byWorkspace.map((w) => (
          <div key={w.workspace ?? "\0"} className="rv-consumer-group" data-workspace={w.workspace ?? ""}>
            <p className="rv-consumer-file">
              {w.workspace ?? "(no workspace)"} ({w.count})
            </p>
            <ul className="rv-list">
              {hub.members
                .filter((m) => m.workspace === w.workspace)
                .map((m) => (
                  <li key={m.id}>
                    <ConsumerRow c={m} sel={sel} onPick={onPick} />
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function Tier({
  title,
  tier,
  list,
  total,
  hubs = [],
  collapsed,
  sel,
  onPick,
}: {
  title: string;
  tier: "direct" | "potential" | "reachable";
  list: ReviewConsumer[];
  total: number;
  hubs?: ReviewHub[];
  /** Consumers of this tier that sit in hubs: counted in `total`, listed only inside a hub row. */
  collapsed: number;
  sel: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <div className={`rv-consumer-${tier}`} data-tier={tier}>
      <h4>
        <HugeiconsIcon icon={Layers01Icon} size={12} aria-hidden="true" className="mr-1 inline-block" />
        {title} ({total})
      </h4>
      {list.length === 0 && hubs.length === 0 ? (
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
                  <ConsumerRow c={c} sel={sel} onPick={onPick} />
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {hubs.map((h) => (
        <HubRow key={h.hub} hub={h} sel={sel} onPick={onPick} />
      ))}
      {total > list.length + collapsed && (
        <p className="muted rv-more">
          and {total - list.length - collapsed} more (all of them in <code>gantry review --json</code>)
        </p>
      )}
    </div>
  );
}

/**
 * The consumers of one change in three tiers: "Directly affected" (they use the changed item itself), "Potentially
 * affected" (they use a direct consumer, hops 2 and 3) and "Reachable" (hop 4 or more), each grouped by file with how
 * it uses it. A hub's consumers are one row that opens to them, grouped by workspace. Picking one selects it; the map
 * zooms to the node that shows it.
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
        collapsed={0}
        sel={sel}
        onPick={onPick}
      />
      <Tier
        title={POTENTIAL_HEADING}
        tier="potential"
        list={consumers.potential}
        total={consumers.potentialTotal}
        collapsed={hubTotal(consumers.hubs, (h) => h.hop < REACHABLE_RING)}
        sel={sel}
        onPick={onPick}
      />
      <Tier
        title={REACHABLE_HEADING}
        tier="reachable"
        list={consumers.reachable}
        total={consumers.reachableTotal}
        hubs={consumers.hubs}
        collapsed={hubTotal(consumers.hubs, (h) => h.hop >= REACHABLE_RING)}
        sel={sel}
        onPick={onPick}
      />
    </section>
  );
}

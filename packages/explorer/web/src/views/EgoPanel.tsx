import { useId } from "react";
import type { FilterPanelProps } from "../slots.ts";
import { getBool, getList, setBool, setList } from "./filterUtils.ts";

export const DEFAULT_HOPS = 2;

const EDGE_KINDS: { id: string; label: string; hint: string }[] = [
  { id: "calls", label: "Calls", hint: "A function calling another function" },
  { id: "renders", label: "Renders", hint: "A component rendering another component" },
  { id: "uses_hook", label: "Uses hook", hint: "A component or hook using a hook" },
  { id: "imports", label: "Imports", hint: "A file importing another file" },
];

/** The server's default connection types: file imports for a file, everything else for a function. */
export function defaultEdgeKinds(focus: string | null): string[] {
  return focus?.startsWith("file:") ? ["imports"] : ["calls", "renders", "uses_hook"];
}

function sideCounts(nodes: FilterPanelProps["nodes"]) {
  let callers = 0;
  let callees = 0;
  for (const n of nodes) {
    const weight = n.kind === "more" ? n.size : 1;
    if (n.side === "in") callers += weight;
    else if (n.side === "out") callees += weight;
  }
  return { callers, callees };
}

export function EgoPanel({ nodes, filters, onFiltersChange, route, onRouteChange }: FilterPanelProps) {
  const sliderId = useId();
  const focus = route?.focus ?? null;
  const hops = route?.hops ?? DEFAULT_HOPS;
  const defaults = defaultEdgeKinds(focus);
  const kinds = getList(filters, "edgeKinds") ?? defaults;
  const centre = nodes.find((n) => n.side === "focus");
  const { callers, callees } = sideCounts(nodes);

  const setKind = (id: string, on: boolean) => {
    const next = on ? [...new Set([...kinds, id])] : kinds.filter((k) => k !== id);
    if (next.length === 0) return; // at least one connection type must stay on
    onFiltersChange(setList(filters, "edgeKinds", next, defaults));
  };

  return (
    <div className="filter-panel" data-view="ego">
      <section className="filter-group" aria-label="Centred on">
        <h3>Centred on</h3>
        {focus ? (
          <>
            <p className="focus-name">{centre?.label ?? focus}</p>
            {centre && (
              <p className="muted">
                {callers} {callers === 1 ? "caller" : "callers"}, {callees}{" "}
                {callees === 1 ? "callee" : "callees"} within {hops} {hops === 1 ? "step" : "steps"}
              </p>
            )}
            {centre && nodes.length === 1 && (
              <p className="notice">
                Nothing is connected within {hops} {hops === 1 ? "step" : "steps"} for the selected connection
                types. Try more steps or turn on more connection types.
              </p>
            )}
            <p className="muted">Search (Cmd/Ctrl+K) to centre on a different function.</p>
          </>
        ) : (
          <p className="muted">Nothing chosen yet. Search for a function to begin.</p>
        )}
      </section>

      <section className="filter-group" aria-label="How far">
        <h3>How far to look</h3>
        <label htmlFor={sliderId} className="slider-label">
          <span>Steps away</span>
          <output htmlFor={sliderId}>{hops}</output>
        </label>
        <input
          id={sliderId}
          type="range"
          min={1}
          max={4}
          step={1}
          value={hops}
          aria-valuetext={`${hops} ${hops === 1 ? "step" : "steps"}`}
          onChange={(e) => {
            const n = Number(e.target.value);
            onRouteChange?.({ hops: n === DEFAULT_HOPS ? null : n });
          }}
        />
        <p className="muted">1 shows direct callers and callees only.</p>
      </section>

      <section className="filter-group" aria-label="Connection types">
        <h3>Connection types</h3>
        {EDGE_KINDS.map((k) => (
          <label className="check" key={k.id} title={k.hint}>
            <input
              type="checkbox"
              checked={kinds.includes(k.id)}
              disabled={kinds.length === 1 && kinds.includes(k.id)}
              onChange={(e) => setKind(k.id, e.target.checked)}
            />
            <span className="check-label">{k.label}</span>
          </label>
        ))}
      </section>

      <section className="filter-group" aria-label="Certainty">
        <h3>Certainty</h3>
        <label className="check" title="Hide links that Gantry could only guess at">
          <input
            type="checkbox"
            checked={getBool(filters, "highConfidence", false)}
            onChange={(e) => onFiltersChange(setBool(filters, "highConfidence", e.target.checked, false))}
          />
          <span className="check-label">High confidence only</span>
        </label>
      </section>
    </div>
  );
}

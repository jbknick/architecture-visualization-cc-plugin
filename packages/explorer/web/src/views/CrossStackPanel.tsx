import { useId, useState } from "react";
import type { Filters, WsCount } from "../api.ts";
import type { FilterPanelProps } from "../slots.ts";
import { getBool, getList, setBool, setList } from "./filterUtils.ts";

// Filter panels of the cross-stack views (#48): endpoints, page -> API, API -> tables, feature path, table usage.

const n = (v: number, one: string, many = `${one}s`) =>
  `${v.toLocaleString("en-US")} ${v === 1 ? one : many}`;
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/** A list filter shown as checkboxes; every box ticked is the default (no key in the URL). */
function CheckList({
  title,
  options,
  filters,
  keyName,
  onFiltersChange,
}: {
  title: string;
  options: { id: string; label: string; note?: string }[];
  filters: Filters;
  keyName: string;
  onFiltersChange: (f: Filters) => void;
}) {
  if (options.length < 2) return null;
  const all = options.map((o) => o.id);
  const picked = getList(filters, keyName);
  const isOn = (id: string) => (picked ? picked.includes(id) : true);
  const set = (id: string, on: boolean) => {
    const cur = picked ?? all;
    const next = on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
    onFiltersChange(setList(filters, keyName, next.length === 0 ? all : next, all));
  };
  return (
    <section className="filter-group" aria-label={title}>
      <h3>{title}</h3>
      {options.map((o) => (
        <label className="check" key={o.id} title={o.id}>
          <input type="checkbox" checked={isOn(o.id)} onChange={(e) => set(o.id, e.target.checked)} />
          <span className="check-text">
            <span className="check-label">{o.label}</span>
            {o.note && <span className="check-note">{o.note}</span>}
          </span>
        </label>
      ))}
    </section>
  );
}

function PrefixInput({
  title,
  placeholder,
  hint,
  filters,
  onFiltersChange,
}: {
  title: string;
  placeholder: string;
  hint: string;
  filters: Filters;
  onFiltersChange: (f: Filters) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (value: string) => {
    setDraft(null);
    const next = { ...filters };
    const v = value.trim();
    if (v === "" || v === "/") delete next.prefix;
    else next.prefix = v;
    if (JSON.stringify(next) !== JSON.stringify(filters)) onFiltersChange(next);
  };
  return (
    <section className="filter-group" aria-label={title}>
      <h3>{title}</h3>
      <input
        id={id}
        type="text"
        className="text-input"
        aria-label={title}
        placeholder={placeholder}
        value={draft ?? filters.prefix ?? ""}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
        }}
      />
      <p className="muted">{hint}</p>
    </section>
  );
}

function Toggle({
  label,
  keyName,
  filters,
  onFiltersChange,
  on = "true",
}: {
  label: string;
  keyName: string;
  filters: Filters;
  onFiltersChange: (f: Filters) => void;
  on?: string;
}) {
  const checked = on === "true" ? getBool(filters, keyName, false) : filters[keyName] === on;
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          if (on === "true") onFiltersChange(setBool(filters, keyName, e.target.checked, false));
          else {
            const next = { ...filters };
            if (e.target.checked) next[keyName] = on;
            else delete next[keyName];
            onFiltersChange(next);
          }
        }}
      />
      <span className="check-text">
        <span className="check-label">{label}</span>
      </span>
    </label>
  );
}

const wsOptions = (ws: WsCount[] | undefined, noun: string) =>
  (ws ?? []).map((w) => ({ id: w.id, label: w.shortLabel, note: n(w.count, noun) }));

function Key({ db = false }: { db?: boolean }) {
  return (
    <p className="muted flow-panel-key">
      {db ? "Blue lines read a table, orange lines write it. " : ""}Dashed lines are uncertain matches (a name
      or a fetch URL, not a resolved import). Hover a line for details.
    </p>
  );
}

/** View 7: endpoints by kind, with filters for workspace, kind, method and path prefix. */
export function EndpointsPanel({ data, filters, onFiltersChange, route, onRouteChange }: FilterPanelProps) {
  const t = data?.totals ?? {};
  const depthId = useId();
  const depth = route?.hops ?? 2;
  return (
    <div className="filter-panel" data-view="endpoints">
      <section className="filter-group" aria-label="What you see">
        <h3>What you see</h3>
        <p className="muted">
          {num(t.shown) === num(t.endpoints)
            ? `${n(num(t.endpoints), "endpoint")}`
            : `${n(num(t.shown), "endpoint")} of ${num(t.endpoints)}`}{" "}
          grouped by kind, each with the middleware it passes through, the code that handles it and what that
          code calls.
          {num(t.withoutHandler) > 0
            ? ` ${n(num(t.withoutHandler), "endpoint")} without a resolved handler.`
            : ""}
          {t.truncated ? " The picture was cut at 1,500 boxes; narrow the filters." : ""}
        </p>
      </section>
      <section className="filter-group" aria-label="How far">
        <h3>How far to look</h3>
        <label htmlFor={depthId} className="slider-label">
          <span>Calls below the handler</span>
          <output htmlFor={depthId}>{depth}</output>
        </label>
        <input
          id={depthId}
          type="range"
          min={1}
          max={4}
          step={1}
          value={depth}
          onChange={(e) => {
            const v = Number(e.target.value);
            onRouteChange?.({ hops: v === 2 ? null : v });
          }}
        />
      </section>
      <CheckList
        title="Kind"
        keyName="kind"
        filters={filters}
        onFiltersChange={onFiltersChange}
        options={(data?.groups ?? []).map((g) => ({
          id: g.id,
          label: g.label,
          note: n(g.count, "endpoint"),
        }))}
      />
      <CheckList
        title="Method"
        keyName="method"
        filters={filters}
        onFiltersChange={onFiltersChange}
        options={(data?.methods ?? []).map((m) => ({ id: m, label: m }))}
      />
      <PrefixInput
        title="Path prefix"
        placeholder="/api/users or posts."
        hint="A URL path, a dotted rpc path or a server function name."
        filters={filters}
        onFiltersChange={onFiltersChange}
      />
      <CheckList
        title="Workspaces"
        keyName="ws"
        filters={filters}
        onFiltersChange={onFiltersChange}
        options={wsOptions(data?.wsCounts, "endpoint")}
      />
    </div>
  );
}

/** View 8: which pages call which endpoints. */
export function PageApiPanel({ data, filters, onFiltersChange }: FilterPanelProps) {
  const t = data?.totals ?? {};
  return (
    <div className="filter-panel" data-view="page-api">
      <section className="filter-group" aria-label="What you see">
        <h3>What you see</h3>
        <p className="muted">
          Pages on the left, endpoints on the right. A line means something the page renders or calls (its
          component tree, loader, hooks) requests that endpoint. {n(num(t.links), "link")} between{" "}
          {n(num(t.routes), "route")} and {n(num(t.endpoints), "endpoint")}.
        </p>
        {num(t.unmatched) > 0 && (
          <p className="muted">
            {n(num(t.unmatched), "client call")} matched no endpoint; the routes that make them say so on
            hover.
          </p>
        )}
        <Key />
      </section>
      <section className="filter-group" aria-label="Show">
        <h3>Show</h3>
        <Toggle
          label={`Also unlinked (${num(t.routesWithout)} routes, ${num(t.endpointsWithout)} endpoints)`}
          keyName="all"
          filters={filters}
          onFiltersChange={onFiltersChange}
        />
      </section>
      <PrefixInput
        title="Route prefix"
        placeholder="/settings"
        hint="Only routes under this URL path."
        filters={filters}
        onFiltersChange={onFiltersChange}
      />
      <CheckList
        title="Apps"
        keyName="ws"
        filters={filters}
        onFiltersChange={onFiltersChange}
        options={wsOptions(data?.wsCounts, "route")}
      />
    </div>
  );
}

/** View 9: which endpoints read or write which tables. */
export function ApiTablesPanel({ data, filters, onFiltersChange }: FilterPanelProps) {
  const t = data?.totals ?? {};
  return (
    <div className="filter-panel" data-view="api-tables">
      <section className="filter-group" aria-label="What you see">
        <h3>What you see</h3>
        <p className="muted">
          {n(num(t.withTables), "endpoint")} of {num(t.endpoints)} reach {n(num(t.tables), "table")}. The
          middle column holds{" "}
          {t.expanded
            ? "every function between the handler and the database call"
            : "the code that makes the database call"}
          .
        </p>
        <Key db />
      </section>
      <section className="filter-group" aria-label="Show">
        <h3>Show</h3>
        <Toggle
          label="Every service function on the way"
          keyName="services"
          on="all"
          filters={filters}
          onFiltersChange={onFiltersChange}
        />
        <Toggle
          label="Also endpoints that reach no table"
          keyName="all"
          filters={filters}
          onFiltersChange={onFiltersChange}
        />
      </section>
      <CheckList
        title="Kind"
        keyName="kind"
        filters={filters}
        onFiltersChange={onFiltersChange}
        options={[
          { id: "rpc", label: "rpc" },
          { id: "http", label: "http" },
          { id: "fn", label: "server fn" },
        ]}
      />
      <PrefixInput
        title="Path prefix"
        placeholder="/api/users or posts."
        hint="A URL path, a dotted rpc path or a server function name."
        filters={filters}
        onFiltersChange={onFiltersChange}
      />
      <CheckList
        title="Workspaces"
        keyName="ws"
        filters={filters}
        onFiltersChange={onFiltersChange}
        options={wsOptions(data?.wsCounts, "endpoint")}
      />
    </div>
  );
}

function Gaps({ gaps, truncated }: { gaps: string[]; truncated: boolean }) {
  if (gaps.length === 0 && !truncated) return null;
  return (
    <section className="filter-group" aria-label="Where the path stops">
      <h3>Where the path stops</h3>
      {truncated && <p className="muted">The trace hit its node limit; the picture is incomplete.</p>}
      <ul className="flow-gaps">
        {gaps.slice(0, 12).map((g) => (
          <li key={g}>
            <code>{g}</code>
          </li>
        ))}
      </ul>
      {gaps.length > 12 && <p className="muted">and {gaps.length - 12} more</p>}
    </section>
  );
}

function FocusLine({ label, onChange }: { label: string; onChange: () => void }) {
  return (
    <p className="flow-focus">
      <strong>{label}</strong>{" "}
      <button type="button" className="link-btn" onClick={onChange}>
        Change
      </button>
    </p>
  );
}

/** View 10: the whole path of one feature, page to table. */
export function FeaturePathPanel({ data, nodes, onRouteChange }: FilterPanelProps) {
  const t = data?.totals ?? {};
  const focus = data?.focus ? nodes.find((x) => x.id === data.focus) : undefined;
  return (
    <div className="filter-panel" data-view="feature-path">
      <section className="filter-group" aria-label="What you see">
        <h3>What you see</h3>
        {focus && (
          <FocusLine label={focus.label} onChange={() => onRouteChange?.({ focus: null, sel: null })} />
        )}
        <p className="muted">
          {data?.focus
            ? `Swimlanes from the page through its client code and endpoints to the services and tables: ${n(num(t.routes), "page")}, ${n(num(t.endpoints), "endpoint")}, ${n(num(t.tables), "table")}.`
            : "Pick a page or an endpoint to follow it from the page to the tables."}
        </p>
        <Key db />
      </section>
      <Gaps gaps={data?.gaps ?? []} truncated={Boolean(data?.truncated)} />
    </div>
  );
}

/** View 11: who touches one table. */
export function TableUsagePanel({ data, onRouteChange }: FilterPanelProps) {
  const t = data?.totals ?? {};
  const table = data?.table;
  return (
    <div className="filter-panel" data-view="table-usage">
      <section className="filter-group" aria-label="What you see">
        <h3>What you see</h3>
        {table && (
          <FocusLine label={table.name} onChange={() => onRouteChange?.({ focus: null, sel: null })} />
        )}
        <p className="muted">
          {table
            ? `The table on the right; to its left the code that writes it (top) and reads it, then their callers up to the endpoints and pages. ${n(num(t.writers), "writer")}, ${n(num(t.readers), "reader")}, ${n(num(t.endpoints), "endpoint")}, ${n(num(t.routes), "page")}.`
            : "Pick a table to see who writes and reads it."}
        </p>
        {table && table.columns.length > 0 && (
          <p className="muted">
            Columns: <code>{table.columns.join(", ")}</code>
          </p>
        )}
        <Key db />
      </section>
      <Gaps gaps={data?.gaps ?? []} truncated={Boolean(data?.truncated)} />
    </div>
  );
}

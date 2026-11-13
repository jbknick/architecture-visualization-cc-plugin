import type { GraphNode, ViewLevel } from "../api.ts";
import { mapView, useMapView } from "../canvas/mapView.ts";
import { useViewData } from "../hooks.ts";
import type { FilterPanelProps } from "../slots.ts";
import { currentScheme } from "../theme.ts";
import { workspaceColorAt } from "../workspacePalette.ts";
import { getBool, getList, setBool, setList } from "./filterUtils.ts";

const LEVELS: { id: ViewLevel; label: string; hint: string }[] = [
  { id: "workspaces", label: "Workspaces", hint: "One box per package or app in the repo" },
  { id: "dirs", label: "Folders", hint: "Workspaces and the folders inside them" },
  { id: "files", label: "Files", hint: "Folders and the files inside them" },
  { id: "symbols", label: "Functions", hint: "Files and the functions inside them" },
];

const KIND_OPTIONS: { id: string; label: string }[] = [
  { id: "function", label: "Functions" },
  { id: "method", label: "Methods" },
  { id: "component", label: "Components" },
  { id: "hook", label: "Hooks" },
  { id: "class", label: "Classes" },
  { id: "type", label: "Types" },
  { id: "interface", label: "Interfaces" },
  { id: "enum", label: "Enums" },
  { id: "const", label: "Constants" },
];
/** What the server shows when no `kinds` filter is given. */
const DEFAULT_KINDS = ["function", "method", "component", "hook"];

/** The focus node and its ancestors, outermost first, read from the `parent` links in the response. */
export function breadcrumbTrail(nodes: GraphNode[], focus: string | null): GraphNode[] {
  if (!focus) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const trail: GraphNode[] = [];
  for (let n = byId.get(focus); n; n = n.parent ? byId.get(n.parent) : undefined) {
    trail.unshift(n);
    if (trail.length > 50) break;
  }
  return trail;
}

function Check({
  label,
  checked,
  onChange,
  title,
  dot,
  note,
  onHover,
  onPick,
  active,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
  dot?: string;
  note?: string;
  onHover?: (on: boolean) => void;
  /** Makes the name a button: clicking it calls this, and the checkbox is left alone. */
  onPick?: () => void;
  active?: boolean;
}) {
  return (
    <label
      className={active ? "check is-active" : "check"}
      title={title}
      onMouseEnter={onHover ? () => onHover(true) : undefined}
      onMouseLeave={onHover ? () => onHover(false) : undefined}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        onFocus={onHover ? () => onHover(true) : undefined}
        onBlur={onHover ? () => onHover(false) : undefined}
      />
      {dot && <span className="kind-dot" style={{ background: dot }} aria-hidden="true" />}
      {onPick ? (
        <button type="button" className="check-text check-pick" onClick={onPick} title={title}>
          <span className="check-label">{label}</span>
          {note && <span className="check-note">{note}</span>}
        </button>
      ) : (
        <span className="check-text">
          <span className="check-label">{label}</span>
          {note && <span className="check-note">{note}</span>}
        </span>
      )}
    </label>
  );
}

/** "1,700 functions · 260 files", from the workspace node's own counts. */
export function workspaceCounts(w: GraphNode): string | undefined {
  const fn = w.stats?.functions;
  const files = w.stats?.files;
  const parts: string[] = [];
  if (fn !== undefined) parts.push(`${fn.toLocaleString("en-US")} ${fn === 1 ? "function" : "functions"}`);
  if (files !== undefined) parts.push(`${files.toLocaleString("en-US")} ${files === 1 ? "file" : "files"}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function ProjectMapPanel({ nodes, filters, onFiltersChange, route, onRouteChange }: FilterPanelProps) {
  // The workspace list always comes from an unfiltered request, so unticked workspaces stay in the list.
  // The mock-only `scenario` flag is the one filter that travels along, so the mock serves the same dataset.
  const all = useViewData("project-map", {
    focus: null,
    level: "workspaces",
    hops: null,
    filters: filters.scenario ? { scenario: filters.scenario } : {},
  });
  const ui = useMapView();
  const workspaces = [...(all.data?.nodes ?? nodes)]
    .filter((n) => n.kind === "workspace")
    .sort((a, b) => (b.stats?.functions ?? 0) - (a.stats?.functions ?? 0) || (a.id < b.id ? -1 : 1));
  // The same colour as the canvas: the workspace's position among all workspaces sorted by id.
  const scheme = currentScheme();
  const colourRank = new Map(
    [...workspaces].sort((a, b) => (a.id < b.id ? -1 : 1)).map((w, i) => [w.id, i] as const),
  );
  const picked = getList(filters, "workspaces");
  const isOn = (id: string) => (picked ? picked.includes(id) : true);
  const setWorkspace = (id: string, on: boolean) => {
    const ids = workspaces.map((w) => w.id).sort();
    const current = picked ?? ids;
    const next = on ? [...new Set([...current, id])] : current.filter((x) => x !== id);
    onFiltersChange(setList(filters, "workspaces", next.length === 0 ? ids : next, ids));
  };

  const kinds = getList(filters, "kinds") ?? DEFAULT_KINDS;
  const setKind = (id: string, on: boolean) => {
    const next = on ? [...new Set([...kinds, id])] : kinds.filter((k) => k !== id);
    onFiltersChange(setList(filters, "kinds", next.length === 0 ? DEFAULT_KINDS : next, DEFAULT_KINDS));
  };

  const focus = route?.focus ?? null;
  const trail = breadcrumbTrail(nodes, focus);
  const focusNode = trail[trail.length - 1];
  // With no explicit level the server shows Files, or just the direct contents when a focus is set.
  const level = route?.level ?? (focus ? null : "files");

  return (
    <div className="filter-panel" data-view="project-map">
      {route && onRouteChange && (
        <>
          <section className="filter-group" aria-label="Where you are">
            <h3>Where you are</h3>
            {focus ? (
              <>
                <nav aria-label="Breadcrumb">
                  <ol className="breadcrumb">
                    <li>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => onRouteChange({ focus: null, level: null })}
                      >
                        Whole repo
                      </button>
                    </li>
                    {trail.map((n, i) => (
                      <li key={n.id}>
                        {i === trail.length - 1 ? (
                          <span aria-current="location" title={n.path ?? n.id}>
                            {n.label}
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="link-btn"
                            title={n.path ?? n.id}
                            onClick={() => onRouteChange({ focus: n.id, level: null })}
                          >
                            {n.label}
                          </button>
                        )}
                      </li>
                    ))}
                    {trail.length === 0 && <li className="muted">{focus}</li>}
                  </ol>
                </nav>
                <button
                  type="button"
                  className="btn"
                  onClick={() => onRouteChange({ focus: null, level: null })}
                >
                  Show whole repo
                </button>
              </>
            ) : (
              <p className="muted">
                Showing the whole repo. Double-click a workspace, folder or file to look inside it.
              </p>
            )}
          </section>

          <section className="filter-group" aria-label="Detail level">
            <h3>How much detail</h3>
            <div className="segmented" role="radiogroup" aria-label="Detail level">
              {LEVELS.map((l) => (
                // biome-ignore lint/a11y/useSemanticElements: a segmented control is a radio group of buttons
                <button
                  key={l.id}
                  type="button"
                  role="radio"
                  aria-checked={level === l.id}
                  title={l.hint}
                  className="segment"
                  onClick={() => onRouteChange({ level: l.id })}
                >
                  {l.label}
                </button>
              ))}
            </div>
            {focus && !route.level && focusNode && (
              <p className="muted">Showing what is directly inside {focusNode.label}.</p>
            )}
          </section>
        </>
      )}

      <section className="filter-group" aria-label="Workspaces">
        <h3>Workspaces</h3>
        {workspaces.length === 0 && (
          <p className="muted">{all.loading ? "Loading workspaces…" : "No workspaces found."}</p>
        )}
        {workspaces.map((w) => (
          <Check
            key={w.id}
            label={w.shortLabel ?? w.label}
            checked={isOn(w.id)}
            dot={workspaceColorAt(colourRank.get(w.id) ?? 0, scheme)}
            note={workspaceCounts(w)}
            title={w.path ? `${w.label} (${w.path})` : w.label}
            onChange={(on) => setWorkspace(w.id, on)}
            onHover={(on) => mapView.setHoverWorkspace(on ? w.id : null)}
            onPick={
              onRouteChange ? () => onRouteChange({ sel: route?.sel === w.id ? null : w.id }) : undefined
            }
            active={route?.sel === w.id}
          />
        ))}
        {picked && (
          <button
            type="button"
            className="link-btn"
            onClick={() => onFiltersChange(setList(filters, "workspaces", [], []))}
          >
            Show all workspaces
          </button>
        )}
      </section>

      {level === "symbols" && (
        <section className="filter-group" aria-label="Kinds of code">
          <h3>Kinds of code</h3>
          <p className="muted">Colour of each function cell. Untick a kind to hide it.</p>
          {KIND_OPTIONS.map((k) => (
            <Check
              key={k.id}
              label={k.label}
              checked={kinds.includes(k.id)}
              dot={`var(--kind-${k.id}, var(--muted))`}
              onChange={(on) => setKind(k.id, on)}
            />
          ))}
        </section>
      )}

      <section className="filter-group" aria-label="Show or hide">
        <h3>Show or hide</h3>
        <Check
          label="Exported only"
          title="Only code that other files can import"
          checked={getBool(filters, "exportedOnly", false)}
          onChange={(on) => onFiltersChange(setBool(filters, "exportedOnly", on, false))}
        />
        <Check
          label="Hide tests"
          title="Leave out test and spec files"
          checked={getBool(filters, "hideTests", true)}
          onChange={(on) => onFiltersChange(setBool(filters, "hideTests", on, true))}
        />
        <Check
          label="Show declared dependencies"
          title="Also draw links that only come from package.json dependencies, with no imports"
          checked={ui.showDeclared}
          onChange={(on) => mapView.setShowDeclared(on)}
        />
        <Check
          label="Show npm packages"
          title="Add the third-party packages your code imports"
          checked={getBool(filters, "showExternal", false)}
          onChange={(on) => onFiltersChange(setBool(filters, "showExternal", on, false))}
        />
      </section>
    </div>
  );
}

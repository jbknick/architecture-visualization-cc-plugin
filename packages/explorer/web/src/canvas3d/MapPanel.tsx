import { useEffect, useMemo, useState } from "react";
import "./map3d.css";
import type { GraphNode } from "../api.ts";
import { LargestFiles } from "../components/LargestFiles.tsx";
import { rankView } from "../rankedFiles/store.ts";
import { useRanked } from "../rankedFiles/useRanked.ts";
import type { FilterPanelProps } from "../slots.ts";
import { currentScheme } from "../theme.ts";
import { getBool, setBool } from "../views/filterUtils.ts";
import { workspaceColorAt } from "../workspacePalette.ts";
import { type IslandSummary, summarizeIslands } from "./layout.ts";
import { type MapStyle, mapUi, prefersReducedMotion, readStyle, rememberStyle, useMapUi } from "./ui.ts";

const LEVELS = [
  { id: "workspaces", label: "Workspaces" },
  { id: "dirs", label: "Folders" },
  { id: "files", label: "Files" },
] as const;

const HOWTO_KEY = "gantry.map3d.howto"; // "open" | "collapsed": the person's own choice
const SEEN_KEY = "gantry.map3d.howto-seen"; // set after the first view; later visits start collapsed
/** Up to this many workspaces the block starts open on a first visit; with more, the list needs the room. */
const OPEN_FIRST_VIEW_MAX = 6;

function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // private window or blocked storage: the block just starts in its default state next time
  }
}

/** The workspaces of the project-map data the city is built from, in palette order (sorted by id). */
export function cityWorkspaces(nodes: readonly GraphNode[]): IslandSummary[] {
  return nodes
    .filter((n) => n.kind === "workspace" && !n.parent)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((n, index) => ({
      id: n.id,
      index,
      label: n.shortLabel ?? n.label,
      fullLabel: n.label,
      wsKind: n.id === "ws:." ? "(repo root)" : (n.badges?.[0] ?? "package"),
      functions: n.stats?.functions ?? 0,
      files: n.stats?.files ?? 0,
    }));
}

/** Left-panel controls for the 3D map: level, hide tests, auto-rotate, reset camera, and the workspace legend. */
export function MapPanel({
  nodes: shellNodes,
  filters,
  onFiltersChange,
  route,
  onRouteChange,
}: FilterPanelProps) {
  const ui = useMapUi();
  const style = readStyle(filters);
  const city = style === "city";
  // The city is built from the project-map data; its panel lists the same workspaces and files.
  const nodes = city && ui.cityData ? ui.cityData.nodes : shellNodes;
  const setStyle = (next: MapStyle) => {
    rememberStyle(next);
    mapUi.touchStyle();
    const { style: _drop, ...rest } = filters;
    onFiltersChange(next === "islands" ? { ...rest, style: "islands" } : rest);
  };
  const level = route?.level === "workspaces" || route?.level === "files" ? route.level : "dirs";
  const hideTests = getBool(filters, "hideTests", true);
  // Biggest first; the colour index stays the island's position in the sorted-id order.
  const islands = useMemo(
    () =>
      (city && ui.cityData ? cityWorkspaces(nodes) : summarizeIslands(nodes)).sort(
        (a, b) => b.functions - a.functions || (a.id < b.id ? -1 : 1),
      ),
    [nodes, city, ui.cityData],
  );
  const scheme = currentScheme();
  const ranked = useRanked(nodes, hideTests, level === "files");
  const reduced = prefersReducedMotion();
  // "How to read it": open on a first visit to a small map, collapsed to one line afterwards; remembered.
  const [seenBefore] = useState(() => readStore(SEEN_KEY) !== null);
  const [choice, setChoice] = useState<boolean | null>(() => {
    const saved = readStore(HOWTO_KEY);
    return saved === "open" ? true : saved === "collapsed" ? false : null;
  });
  const howtoOpen = choice ?? (!seenBefore && islands.length <= OPEN_FIRST_VIEW_MAX);
  useEffect(() => {
    if (islands.length > 0) writeStore(SEEN_KEY, "1");
  }, [islands.length]);

  return (
    <div className="map3d-panel">
      <div className="map3d-toprow">
        <fieldset className="map3d-styles" aria-label="Style">
          <div className="map3d-seg">
            {(
              [
                ["city", "City"],
                ["islands", "Islands"],
              ] as const
            ).map(([id, label]) => (
              <label key={id} className={`map3d-seg-opt ${style === id ? "is-on" : ""}`}>
                <input type="radio" name="map3d-style" checked={style === id} onChange={() => setStyle(id)} />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        {!city && (
          <button type="button" className="map3d-reset" onClick={() => mapUi.resetCamera()}>
            Reset camera
          </button>
        )}
      </div>
      {city && (
        <div className="map3d-views">
          <button type="button" className="map3d-reset" onClick={() => mapUi.setCameraView("top")}>
            Top view
          </button>
          <button type="button" className="map3d-reset" onClick={() => mapUi.setCameraView("angled")}>
            Angled view
          </button>
          <button
            type="button"
            className="map3d-reset"
            disabled={ui.smallCount === 0}
            title="Frame the districts with very few functions, with their names and arch ends"
            onClick={() => mapUi.setCameraView("small")}
          >
            Focus small workspaces
          </button>
          <button type="button" className="map3d-reset" onClick={() => mapUi.resetCamera()}>
            Reset camera
          </button>
        </div>
      )}
      <fieldset className="map3d-levels">
        <legend className="muted">Level</legend>
        {LEVELS.map((l) => (
          <label key={l.id} className="map3d-radio">
            <input
              type="radio"
              name="map3d-level"
              checked={level === l.id}
              onChange={() => onRouteChange?.({ level: l.id === "dirs" ? null : l.id })}
            />
            {l.label}
          </label>
        ))}
      </fieldset>
      {level === "files" && (
        <LargestFiles
          files={ranked.files}
          scope={ranked.scope}
          scopes={ranked.scopes}
          onScope={rankView.setScope}
          colorOf={(id) => workspaceColorAt(islands.find((i) => i.id === id)?.index ?? 0, scheme)}
          onSelect={(id) => onRouteChange?.({ sel: id })}
          onFocus={rankView.focus}
          onHover={rankView.setHoverFile}
          selectedId={route?.sel}
        />
      )}
      <section className="map3d-howto" aria-label="How to read this map">
        <button
          type="button"
          className="map3d-howto-toggle"
          aria-expanded={howtoOpen}
          aria-controls="map3d-howto-body"
          onClick={() => {
            setChoice(!howtoOpen);
            writeStore(HOWTO_KEY, howtoOpen ? "collapsed" : "open");
          }}
        >
          <span className="map3d-howto-chevron" aria-hidden="true">
            ▶
          </span>
          <span className="panel-title">How to read it</span>
        </button>
        {howtoOpen && city && (
          <ul id="map3d-howto-body">
            <li>
              <span className="map3d-sw map3d-sw-island" aria-hidden="true" />
              <span>
                <strong>District</strong> = one workspace, laid out like the 2D project map (area =
                functions). Colour = workspace, as in the list below.
              </span>
            </li>
            <li>
              <svg className="map3d-sw map3d-sw-arrow" viewBox="0 0 26 10" aria-hidden="true">
                <path d="M1 5 H17" stroke="currentColor" strokeWidth="2.4" fill="none" />
                <path d="M16 0.8 L25 5 L16 9.2 Z" fill="currentColor" />
              </svg>
              <span>
                <strong>Arch A → B</strong> = A imports from B. Colour = the importer, thicker = more imports,
                the number is the import count.
              </span>
            </li>
            <li>
              <span className="map3d-sw map3d-sw-dot" aria-hidden="true" />
              <span>
                {level === "workspaces" && "Block height = functions in the workspace."}
                {level === "dirs" && (
                  <>
                    <strong>Plinth</strong> = folder; the tall blocks are the folders with the most functions.
                  </>
                )}
                {level === "files" && (
                  <>
                    <strong>Building</strong> = file, height = functions. <strong>Flags</strong> = largest
                    files, listed on the left.
                  </>
                )}
              </span>
            </li>
          </ul>
        )}
        {howtoOpen && !city && (
          <ul id="map3d-howto-body">
            <li>
              <span className="map3d-sw map3d-sw-island" aria-hidden="true" />
              <span>
                <strong>Island</strong> = one workspace. Size = number of functions. Colour = workspace, as in
                the list below.
              </span>
            </li>
            <li>
              <svg className="map3d-sw map3d-sw-arrow" viewBox="0 0 26 10" aria-hidden="true">
                <path d="M1 5 H17" stroke="currentColor" strokeWidth="2.4" fill="none" />
                <path d="M16 0.8 L25 5 L16 9.2 Z" fill="currentColor" />
              </svg>
              <span>
                <strong>Arrow A → B</strong> = A imports from B. Thicker = more imports. The number is the
                import count; its small arrow points at the imported workspace.
              </span>
            </li>
            <li>
              <span className="map3d-sw map3d-sw-dot" aria-hidden="true" />
              <span>
                {level === "workspaces" && "Workspaces level: one sphere per workspace."}
                {level === "dirs" && (
                  <>
                    <strong>Sphere</strong> = folder (size = functions). Labels show name and functions.
                  </>
                )}
                {level === "files" && (
                  <>
                    <strong>Ring</strong> = folder; <strong>dot</strong> = file (size = functions).{" "}
                    <strong>Numbers</strong> = largest files, listed on the left.
                  </>
                )}
              </span>
            </li>
          </ul>
        )}
      </section>
      <label className="map3d-check">
        <input
          type="checkbox"
          checked={hideTests}
          onChange={(e) => onFiltersChange(setBool(filters, "hideTests", e.target.checked, true))}
        />
        Hide tests
      </label>
      <label className="map3d-check">
        <input
          type="checkbox"
          checked={ui.autoRotate && !reduced}
          disabled={reduced}
          onChange={(e) => mapUi.setAutoRotate(e.target.checked)}
        />
        Auto-rotate{reduced ? " (off: reduced motion)" : ""}
      </label>
      <label
        className="map3d-check"
        title="Also draw links that only come from package.json dependencies, with no imports"
      >
        <input
          type="checkbox"
          checked={ui.showDeclared}
          onChange={(e) => mapUi.setShowDeclared(e.target.checked)}
        />
        Show declared dependencies
      </label>

      <h3 className="panel-title legend-title">Workspaces</h3>
      <ul className="map3d-legend">
        {islands.map((i) => (
          <li key={i.id}>
            <button
              type="button"
              className={`map3d-legend-row ${ui.island === i.id ? "is-active" : ""}`}
              aria-pressed={ui.island === i.id}
              title={i.fullLabel}
              onClick={() => mapUi.focusIsland(i.id)}
              onMouseEnter={() => mapUi.setHoverIsland(i.id)}
              onMouseLeave={() => mapUi.setHoverIsland(null)}
              onFocus={() => mapUi.setHoverIsland(i.id)}
              onBlur={() => mapUi.setHoverIsland(null)}
            >
              <span
                className="kind-dot"
                style={{ background: workspaceColorAt(i.index, scheme) }}
                aria-hidden="true"
              />
              <span className="map3d-legend-name">{i.label}</span>
              <span className="map3d-legend-count">{i.functions.toLocaleString("en-US")} fn</span>
              <span className="map3d-legend-meta">
                {i.wsKind} · {i.files.toLocaleString("en-US")} {i.files === 1 ? "file" : "files"}
              </span>
            </button>
          </li>
        ))}
        {islands.length === 0 && <li className="muted">No workspaces in this view.</li>}
      </ul>
    </div>
  );
}

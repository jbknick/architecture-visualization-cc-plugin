# Explorer web shell

Vite + React + TypeScript app for `gantry map`. `pnpm build` writes it to `plugin/dist/explorer/` (hashed assets); the server (#33) serves that directory.

```
pnpm --filter @gantry/explorer test   # vitest + jsdom component tests
pnpm --filter @gantry/explorer e2e    # builds the UI, then Playwright: a smoke test on the mock API and
                                      # a real-server test (needs `pnpm build` at the root first)
pnpm --filter @gantry/explorer mock   # serve the built UI plus the mock API on :4173
```

Set `MOCK_PORT` if 4173 is taken. The real-server test copies `fixtures/pnpm-turbo` into a temp git repo, runs `gantry init` and `gantry map --no-open` with a temp `CLAUDE_PLUGIN_DATA`, and writes `docs/milestones/screenshots/{project-map,ego}-fixture.png`.

## Layout

Top bar (repo, short sha, view tabs, search, Cmd/Ctrl+K), left slot (filters, collapsible), center slot (canvas), right inspector (opens when `focus` is set), status bar.

## Files

- `src/api.ts`: the only module that calls the server. Types for `GraphNode`, `GraphEdge`, `Meta`, `NodeDetail`, `SearchHit`.
- `src/route.ts`: hash routes `#/<view>?focus=<id>&level=<level>&hops=<n>&sel=<id>&<filters>`. `focus`, `level` (`workspaces|dirs|files|symbols`) and `hops` (1-4) are sent to `/api/view/:id` as query params of the same name. `sel` is the node open in the inspector and never reaches the server. Every other key is a filter (`hideTests=false`, `workspaces=ws:a|ws:b`, `edgeKinds=calls|renders`); filters are sent as one `filters` param holding a JSON object, which the server's `parseOptions` reads. List values are `|` separated.
- `src/views/`: the project-map and ego filter panels, the ego "pick a function" prompt, and double-click ("go into") rules in `drill.ts`. Registered from `views/index.ts`.
- `src/store.tsx`: React context + reducer. The hash is the source of truth for view, focus, depth and filters, so back/forward works.
- `src/theme.ts`: fixed kind colors (light and dark). Written as `--kind-<name>` CSS variables; canvases import `kindColor(kind, scheme)`.
- `mock/`: fixture graph and a small `node:http` server. Its responses mirror the real server's shapes (including `level`, `focus`, `hops` and filter handling for `project-map` and `ego`), so change it together with `server/api.ts` and `server/views/*`. Used by component tests and the smoke test; not shipped.

## 3D map

`src/canvas3d/` renders the `map-3d` view (layoutHint `force-3d`) with `3d-force-graph`/three.js in a lazy chunk. `layout.ts` is pure and deterministic (seeded by id hashes, fixed ticks, no `Math.random`); `scene.ts` is the three.js side; `MapPanel.tsx` is the left panel (level, hide tests, auto-rotate, reset camera, workspace legend). Hash route: `#/map-3d?level=workspaces|dirs|files&hideTests=false&sel=<id>`. `level` (default `dirs`) goes through the route's `onRouteChange`, `hideTests` (default true) through the filters, like the project map. Clicking a node or island sets `sel` (inspector); the view's `focus` is not used. Double-click flies the camera to the node; it does not call `onDrill`, because the 3D map has no subtree view (the level switch is the zoom). Island colours come from `src/workspacePalette.ts`, shared with the project-map panel. Readability on big monorepos: workspace nodes carry `shortLabel` (the npm scope shared by most workspaces is stripped, `server/views/labels.ts`; the project map sets it too, the full name stays in `label` for tooltips and the inspector). Island radius follows sqrt(function count) with a floor, `placeIslands` in `layout.ts` keeps every pair of islands at least `r1 + r2 + islandGap` apart (big islands on a ring, tiny ones next to the islands they import from), and `scene.ts` places labels in screen space every frame by priority (hovered or selected island, then island names by function count, then detail lines, then file and folder labels), shrinking or hiding the ones that would overlap. Arcs: only imports by default (`Show declared dependencies` adds `depends_on`-only links), width is sqrt(weight), and hovering or selecting an island (or its legend row) shows its arcs with `A → B: N imports` labels and dims the rest. Auto-rotate is off by default. The mock API serves a second, monorepo-shaped dataset (3 huge and 8 tiny workspaces, long scoped names) for `#/map-3d?scenario=large`; the e2e writes `map-3d-large-{workspaces,folders,files}.png` from it.

The Playwright tests need software WebGL (`--use-angle=swiftshader`) and write `docs/milestones/screenshots/map-3d.png` (mock data) and `map-3d-fixture.png` (real server, pnpm-turbo fixture).

## Canvas slot

A view returns `layoutHint` from `/api/view/:id`. The shell renders the component registered for that hint and falls back to the default, the placeholder windowed list.

```ts
import { registerCanvas, type CanvasProps } from "./slots.ts";

// CanvasProps: { nodes, edges, layoutHint, focus, onSelect, onHover }
registerCanvas("force", ForceCanvas); // eager
registerCanvas("3d", Canvas3d); // Canvas3d lazy-loads its chunk and renders its own <Suspense>
```

Register in `src/canvases.ts` (imported by `App.tsx`). `focus` is the focused node id or `null`. Call `onSelect(id)` to focus a node (updates the hash and opens the inspector) and `onSelect(null)` to clear it. Call `onHover(id | null)` for hover state. Use `kindColor` from `theme.ts` for node colors.

## Filter slot

`registerFilterPanel(viewId, Panel)`, where `Panel` receives `{ viewId, nodes, edges, filters, onFiltersChange, route, onRouteChange }`. `onFiltersChange` writes the hash filters and refetches the view; `onRouteChange({ focus, level, hops })` changes the view params. Views without a panel show "This view has no filters."

`registerFocusRequired(viewId, Prompt)` marks a view that needs `focus` (the ego view): no request is sent until it is set, and `Prompt` fills the centre meanwhile. A canvas may also call the optional `onDrill(id)` prop on double-click.

## Security

Descriptions, signatures and source are untrusted text. They render as React text nodes only; never use `dangerouslySetInnerHTML`. The source highlighter returns typed token strings, not markup.

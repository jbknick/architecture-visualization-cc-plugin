# Explorer web shell

Vite + React + TypeScript app for `gantry map`. `pnpm build` writes it to `plugin/dist/explorer/` (hashed assets); the server (#33) serves that directory.

```
pnpm --filter @gantry/explorer test   # vitest + jsdom component tests
pnpm --filter @gantry/explorer e2e    # builds the UI, then Playwright: a smoke test on the mock API and
                                      # a real-server test (needs `pnpm build` at the root first)
pnpm --filter @gantry/explorer perf   # opens the synthetic 30k-function graph in Playwright and prints fps
pnpm --filter @gantry/explorer mock   # serve the built UI plus the mock API on :4173
```

Set `MOCK_PORT` if 4173 is taken. The real-server test copies `fixtures/pnpm-turbo` into a temp git repo, runs `gantry init` and `gantry map --no-open` with a temp `CLAUDE_PLUGIN_DATA`, and writes `docs/milestones/screenshots/{project-map,ego}-fixture.png`.

## Layout

Top bar (repo, short sha, view tabs, search, Cmd/Ctrl+K), left slot (filters, collapsible), center slot (canvas), right inspector (opens when `focus` is set), status bar.

## Files

- `src/api.ts`: the only module that calls the server. Types for `GraphNode`, `GraphEdge`, `Meta`, `NodeDetail`, `SearchHit`.
- `src/route.ts`: hash routes `#/<view>?focus=<id>&level=<level>&hops=<n>&sel=<id>&<filters>`. `focus`, `level` (`workspaces|dirs|files|symbols`) and `hops` (1-4) are sent to `/api/view/:id` as query params of the same name. `sel` is the node open in the inspector and never reaches the server. Every other key is a filter (`hideTests=false`, `workspaces=ws:a|ws:b`, `edgeKinds=calls|renders`); filters are sent as one `filters` param holding a JSON object, which the server's `parseOptions` reads. List values are `|` separated.
- `src/views/`: the project-map and ego filter panels (the project map's lists workspaces by short name with their counts and holds the `Show declared dependencies` toggle), the ego "pick a function" prompt, and double-click ("go into") rules in `drill.ts`. Registered from `views/index.ts`.
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

## Graph canvas (`src/canvas/`)

The canvas registered for `nested-elk`, `elk-layered`, `radial`, `force`, `tree-lr`, `columns`, `clusters` and the server hints `layered`, `tree`, `grid`. `CanvasHost` wraps it with a List / Graph toggle and lazy-loads it. `GraphCanvas.tsx` builds the scene and picks one of two renderers: hierarchical data (the project map: workspaces, folders, files, functions) gets the treemap canvas; flat graphs (ego, debug) keep the sigma canvas.

### Project map: workspace boxes with a treemap inside

- `mapLayout.ts` (in the layout worker): workspace boxes in a layered left-to-right dependency diagram (elk, orthogonal edge routing). Box area is proportional to `stats.functions` of the workspace node, with a floor (180 x 96 px) so tiny workspaces stay clickable and labelled. Units are "pixels at the fit zoom of a canvas of the given `viewport` size": the layout bisects the box area per function so the whole diagram just fits the canvas, with at least 60px between boxes, and sizes the title strip (name, then "app · N functions · N files") and the folder title bars so they read at that fit. Only import links take part in the layering (package.json dependencies can chain every workspace behind the next and stretch the diagram into a strip); declared-only links are routed around the placed boxes afterwards (`route.ts`). The layout is deterministic and follows from the data, so nothing is saved through `/api/layout` for hierarchical maps (flat graphs still save). The canvas asks for a new layout when it is resized by more than 12% (the inspector opens, the window changes) and the user has not moved the camera.
- `treemap.ts`: squarified treemap (area proportional to weight, ties by id, cells laid out about 1.7x wider than tall so names fit). Folders get a title bar, files are cells inside their folder, functions are chips inside their file. A file with no functions keeps a minimum weight so it shows as a thin cell. `fitCellLabel` is the label rule: a label is drawn only when it fits inside its cell at 10px or more; a name too long for the cell is middle-ellipsized only when the cell is at least 60px wide, otherwise it gets no label, so labels never overlap.
- `mapDraw.ts` + `TreemapCanvas.tsx`: everything is drawn on one 2D canvas with its own pan/zoom camera (drag, wheel, `+`/`-`, `0` fits, Esc clears). Cells under 2px and cells outside the viewport are skipped, which keeps the 30k-function map at 60fps. Picking descends the rectangle tree under the pointer (hover tooltip, click selects, double-click calls `onDrill`). The camera fits the whole diagram inside the free area (the strip with the controls above and the status chip below are kept clear) on load, on level change and on resize, unless the user moved it.
- Workspace links: only import links by default; `Show declared dependencies` in the left panel adds the declared-only ones (dashed). Width is `clamp(0.8 + 0.4 * sqrt(weight))`; the bottom third by weight is thin and faint; count pills only on the 8 heaviest. Hovering or selecting a workspace (or its row in the left panel) shows its links in full with `A → B: N imports` pills and dims the rest. Selecting a folder, file or function draws its links to other cells as thin curves with arrowheads (`selectionLinks` in `scene.ts`) and dims the rest.
- Names: workspace nodes carry `shortLabel` (the npm scope shared by most workspaces is stripped, `server/views/labels.ts`); the canvas, the left panel and the legend use it, the full name is in tooltips and the inspector. Counts printed on a box always come from the workspace node's own `stats`.
- One legend: the left panel lists the workspaces with their colours (and the function kinds at the Functions level). The floating `Legend` is collapsed by default in the strip above the diagram and is not drawn at all for views that have a left panel.
- The level control decides how much data the server sends (Workspaces, Folders, Files, Functions); the map draws all of it at the fit zoom, and zooming in reveals more labels.
- `scenario=large` (mock only, like the 3D view's flag) serves `mock/largeMap.ts`: 11 workspaces (three big, eight tiny), long scoped names, nested folders, ~850 files, ~3,700 functions, weighted imports (1 to 640) and 31 declared-only links. `e2e/map2d.spec.ts` writes `docs/milestones/screenshots/map-2d-large-{workspaces,folders,files,functions,dark,selected}.png` from it.

### Flat graphs

- `GraphCanvas.tsx` (sigma + graphology): selection, hover tooltips, controls, keyboard. `layout.ts` (+ `layout.worker.ts`, `layoutClient.ts`): force (ForceAtlas2 from a hash-seeded start), elk layered, radial, tree, columns, clusters or grid, in a Web Worker. No `Math.random`. Positions persist through `GET/PUT /api/layout/:view` (`layouts` table): known nodes keep their saved position, Re-layout recomputes from scratch. `radial` layouts depend on `focus`, so they are not saved.
- Selection and dimming are sigma item states set in batches. Do not add a sigma `nodeReducer` or `edgeReducer`: with one, sigma re-evaluates every node and edge each time the camera starts or stops moving.
- `hierarchy.ts`: containment tree. `scene.ts`: everything derived from nodes and edges (workspace links, counts, selection sets). `zoom.ts`: the far / mid / near band reported in `data-level`. `style.ts`: workspace palette (indexed by sorted id) and theme. `synthetic.ts`: seeded 30k-function generator used by `pnpm --filter @gantry/explorer perf`.

Test hooks on the canvas element: dispatch `gantry:zoom-to` (`detail: { id }`) on `[data-testid=graph-canvas]` to fly to a node, and `gantry:probe` on `.gc-sigma` to write hit geometry (workspace boxes, links, where each title went) and a hash of the positions to `data-probe`.

## Filter slot

`registerFilterPanel(viewId, Panel)`, where `Panel` receives `{ viewId, nodes, edges, filters, onFiltersChange, route, onRouteChange }`. `onFiltersChange` writes the hash filters and refetches the view; `onRouteChange({ focus, level, hops })` changes the view params. Views without a panel show "This view has no filters."

`registerFocusRequired(viewId, Prompt)` marks a view that needs `focus` (the ego view): no request is sent until it is set, and `Prompt` fills the centre meanwhile. A canvas may also call the optional `onDrill(id)` prop on double-click.

## Security

Descriptions, signatures and source are untrusted text. They render as React text nodes only; never use `dangerouslySetInnerHTML`. The source highlighter returns typed token strings, not markup.

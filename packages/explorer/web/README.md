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

- `mapLayout.ts` (in the layout worker): workspace boxes in a layered dependency diagram (elk, orthogonal edge routing). Box area is proportional to `stats.functions` of the workspace node, with a floor (120 x 64 px) so tiny workspaces stay clickable and labelled. Units are "pixels at the fit zoom of a canvas of the given `viewport` size". The layout tries a few deterministic option sets (box shape, layering strategy, spacing 36-48 px, left-to-right or top-to-bottom, and how many layers the heaviest links may form: lighter links are routed around the placed boxes afterwards, like the declared-only ones), bisects the box area per function so the whole diagram just fits the canvas for each, and keeps the set whose biggest box ends up largest on screen (preferring one that is at least a quarter of the canvas wide). The camera fits the diagram to the canvas with 24-44 px of free space, so it fills the limiting dimension. The layout is deterministic and follows from the data, so nothing is saved through `/api/layout` for hierarchical maps (flat graphs still save). The canvas asks for a new layout when it is resized by more than 12% (the inspector opens, the window changes) and the user has not moved the camera.
- `treemap.ts`: squarified treemap (area proportional to weight, ties by id, cells laid out about 1.7x wider than tall so names fit). It is laid out in a normalized content rectangle: no header space is reserved. A file with no functions keeps a minimum weight so it shows as a thin cell. Label rules: `fitCellLabel` draws a label only when it fits at 10px or more (middle-ellipsis only in cells at least 60px wide); `fitFileLabel` tries the whole name at 11px, then 10px, then without its extension, then two lines broken at `.`/`-`/`_`/camelCase, and only then the ellipsis.
- `mapGeom.ts`: headers are a constant size on screen (workspace title block at most 44px: name up to 18px, detail line up to 12px; folder strip at most 20px, shown for every folder that is at least 70 x 28px, three levels deep, deeper ones show their name on hover; file-name strip at most 16px). The content rectangle of a container is its on-screen rectangle minus the header that fits at the current zoom; children are mapped from their normalized rectangles into it (`mapChild`), by drawing and picking alike, so picking is exact and nothing is laid out again when the zoom changes. `hierarchy.ts` `collapseChains` skips a lone folder under a workspace or folder (no box, no header; its name is added to the parent's detail line or strip, e.g. `src/`) when the container has no files of its own, or when its loose files (config files beside `src`) hold under 10% of its functions; those files then sit in one small `(root files)` group cell (`withRootFileGroups` in `scene.ts`, kind `group`, id `rootfiles:<parent id>`, hover lists the paths, clicking it means the parent). Server ids are unchanged. At the Folders level the canvas asks once for `level=files` in the background (`useMosaicFiles`, cached per focus and filters) and draws those files as a faint, unlabelled mosaic inside folders (`scene.mosaic`; not pickable).
- `mapDraw.ts` + `TreemapCanvas.tsx`: everything is drawn on one 2D canvas with its own pan/zoom camera (drag, wheel, `+`/`-`, `0` fits, Esc clears). Cells under 2px and cells outside the viewport are skipped, which keeps the 30k-function map at 60fps. Sibling cells alternate between two close tints and are separated by a contrasting 1px line. Picking descends the rectangle tree under the pointer (hover tooltip, click selects, double-click calls `onDrill`). The camera fits the whole diagram inside the free area (the strip with the controls above and the status chip below are kept clear) on load, on level change and on resize, unless the user moved it. Hovering a workspace row in the left panel outlines its box and dims the others; clicking the row's name selects it (the checkbox still toggles visibility).
- Workspace links: only import links by default; `Show declared dependencies` in the left panel adds the declared-only ones (dashed). Width is `clamp(0.8 + 0.4 * sqrt(weight))`; the bottom third by weight is thin and faint; count pills only on the 8 heaviest. Hovering or selecting a workspace (or its row in the left panel) shows its links in full with `A → B: N imports` pills and dims the rest. Selecting a folder, file or function draws its links to other cells as thin curves with arrowheads (`selectionLinks` in `scene.ts`) and dims the rest.
- Names: workspace nodes carry `shortLabel` (the npm scope shared by most workspaces is stripped, `server/views/labels.ts`); the canvas, the left panel and the legend use it, the full name is in tooltips and the inspector. Counts printed on a box always come from the workspace node's own `stats`. A workspace box always shows a title: inside the box (wrapped to two lines or shrunk to 10px, detail line dropped if needed), else beside it, else on the box itself over a halo; the repo-root workspace (`ws:.`) shows as `(repo root)` with its name in the detail line when the name does not fit. Link counts (pills, hover labels, arrow width) are the `imports` weight only: a `depends_on` edge never adds to them, and a pair with both keeps one arrow with the import count. The layout/timing chip at the bottom left is debug text, shown only with `?debug=1` (or `localStorage.gantry.debug = "1"`). Test hook: `data-probe` (event `gantry:probe`) lists the drawn pills, title texts and title placement.
- One legend: the left panel lists the workspaces with their colours (and the function kinds at the Functions level). The floating `Legend` is collapsed by default in the strip above the diagram and is not drawn at all for views that have a left panel.
- The level control decides how much data the server sends (Workspaces, Folders, Files, Functions); the map draws all of it at the fit zoom, and zooming in reveals more labels.
- `scenario=large` (mock only, like the 3D view's flag) serves `mock/largeMap.ts`: 11 workspaces (three big, eight tiny), long scoped names, nested folders, ~850 files, ~3,700 functions, weighted imports (1 to 640) and 31 declared-only links. `e2e/map2d.spec.ts` writes `docs/milestones/screenshots/map-2d-large-{workspaces,folders,files,functions,dark,selected,zoomed,zoomed-dark}.png` from it.

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

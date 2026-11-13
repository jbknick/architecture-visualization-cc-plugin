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

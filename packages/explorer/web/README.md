# Explorer web shell

Vite + React + TypeScript app for `gantry map`. `pnpm build` writes it to `plugin/dist/explorer/` (hashed assets); the server (#33) serves that directory.

```
pnpm --filter @gantry/explorer test   # vitest + jsdom component tests
pnpm --filter @gantry/explorer e2e    # builds, then Playwright smoke test against the mock API
pnpm --filter @gantry/explorer mock   # serve the built UI plus the mock API on :4173
```

## Layout

Top bar (repo, short sha, view tabs, search, Cmd/Ctrl+K), left slot (filters, collapsible), center slot (canvas), right inspector (opens when `focus` is set), status bar.

## Files

- `src/api.ts`: the only module that calls the server. Types for `GraphNode`, `GraphEdge`, `Meta`, `NodeDetail`, `SearchHit`.
- `src/route.ts`: hash routes `#/<view>?focus=<id>&depth=<n>&<filters>`. Every key other than `focus` and `depth` is a filter, sent to `/api/view` as one `filters` param (`k=v&k2=v2`, URL-encoded).
- `src/store.tsx`: React context + reducer. The hash is the source of truth for view, focus, depth and filters, so back/forward works.
- `src/theme.ts`: fixed kind colors (light and dark). Written as `--kind-<name>` CSS variables; canvases import `kindColor(kind, scheme)`.
- `mock/`: fixture graph and a small `node:http` server. Used by tests and the smoke test; not shipped.

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

`registerFilterPanel(viewId, Panel)`, where `Panel` receives `{ viewId, nodes, edges, filters, onFiltersChange }`. `onFiltersChange` writes the hash and refetches the view. Views without a panel show "This view has no filters."

## Security

Descriptions, signatures and source are untrusted text. They render as React text nodes only; never use `dangerouslySetInnerHTML`. The source highlighter returns typed token strings, not markup.

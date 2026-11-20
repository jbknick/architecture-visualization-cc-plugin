# UI kit sources

The explorer's chrome is built from copied source: nothing here is fetched at build time or at run time. Each file
below was added with `pnpm dlx shadcn@latest add @smoothui/<name>` (the shadcn CLI is not a dependency) and kept with
SmoothUI's MIT notice at the top (Copyright (c) 2024 Eduardo Calvo, https://github.com/educlopez/smoothui).

## SmoothUI components (this folder)

One row per copied file.

| Component                  | File                               | Registry URL                           | Copied     |
| -------------------------- | ---------------------------------- | -------------------------------------- | ---------- |
| tabs                       | `tabs/index.tsx`                   | https://smoothui.dev/r/tabs.json       | 2026-11-20 |
| tabs                       | `tabs/use-active-tab-indicator.ts` | https://smoothui.dev/r/tabs.json       | 2026-11-20 |
| breadcrumb                 | `breadcrumb/index.tsx`             | https://smoothui.dev/r/breadcrumb.json | 2026-11-20 |
| lib (breadcrumb's helpers) | `lib/animation.ts`                 | https://smoothui.dev/r/lib.json        | 2026-11-20 |
| lib (breadcrumb's helpers) | `lib/springs.ts`                   | https://smoothui.dev/r/lib.json        | 2026-11-20 |

Edits after copying: `breadcrumb/index.tsx` uses a Hugeicons icon instead of the registry's default icon package and lets an item set the
`aria-current` token of the last item (the explorer's breadcrumb marks it `location`). `lib/use-fluid-hover.ts`, which
`lib` also ships, is not copied: nothing uses it.

## shadcn primitives (`../ui/`, base-nova style on Base UI)

Used where SmoothUI has no component for the control (fallback order: SmoothUI, then a shadcn primitive on the same
style, then hand-written). Copied on 2026-11-20 from https://ui.shadcn.com/r/styles/base-nova/<name>.json.

| Primitive       | Used for                                                        |
| --------------- | --------------------------------------------------------------- |
| `button`        | every chrome button, and the segments of the segmented controls |
| `badge`         | the stale marker, kind badges, the badge key                    |
| `checkbox`      | every filter checkbox (Base UI renders `role="checkbox"`)       |
| `input`         | the search box and the text fields                              |
| `native-select` | the two `<select>` menus (kept native so `selectOption` works)  |

`button` and `badge` call `class-variance-authority` in the registry; here they use plain lookup tables because that
package is not an approved dependency (docs/SPEC.md section 2). The icon imports that came with the primitives are
Hugeicons (`@hugeicons/core-free-icons`).

## Hand-written, and why

- Range sliders (`<input type="range">`): the specs and component tests drive `role="slider"` with `fill`, which needs
  the native input; neither SmoothUI's `scrubber` nor Base UI's slider has one.
- `components/Segment.tsx`: a `role="radio"` button, so the segmented controls keep the ARIA radio roles the specs use.
- The function badges (`.badge-dup`, `.badge-misleading`, `.badge-undescribed`): their colour pairs are checked for
  contrast and are not a kit component.
- The canvases' own overlays (`.gc-btn` zoom buttons, the Duplicates canvas's action buttons, the review rings' zoom
  buttons) live in canvas files, which this change does not edit.

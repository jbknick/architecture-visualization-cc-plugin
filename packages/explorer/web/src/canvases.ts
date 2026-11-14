// Registers the built-in canvas renderers. Later issues add their own imports here
// (for example a lazily imported 3D canvas).

import { CanvasHost } from "./canvas/CanvasHost.tsx";
import { Canvas3D } from "./canvas3d/index.tsx";
import { MapPanel } from "./canvas3d/MapPanel.tsx";
import { ListCanvas } from "./components/ListCanvas.tsx";
import { registerCanvas, registerFilterPanel, setDefaultCanvas } from "./slots.ts";
import { DuplicatesCanvas } from "./views/DuplicatesCanvas.tsx";

setDefaultCanvas(ListCanvas);
registerCanvas("list", ListCanvas);
registerCanvas("force-3d", Canvas3D); // lazy: three.js loads only when the map-3d view is opened
registerFilterPanel("map-3d", MapPanel);

// The sigma graph canvas (#36) handles every 2D hint; the List / Graph toggle keeps the list one click away.
for (const hint of [
  "nested-elk",
  "elk-layered",
  "radial",
  "force",
  "tree-lr",
  "bowtie",
  "columns",
  "clusters",
  "layered",
  "tree",
  "grid",
]) {
  registerCanvas(hint, CanvasHost);
}

// The duplicates view is a ranked list with a detail pane, not a graph: it takes over the "clusters" hint.
registerCanvas("clusters", DuplicatesCanvas);

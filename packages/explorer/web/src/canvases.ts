// Registers the built-in canvas renderers. Later issues add their own imports here
// (for example a sigma 2D canvas, and a lazily imported 3D canvas).

import { Canvas3D } from "./canvas3d/index.tsx";
import { MapPanel } from "./canvas3d/MapPanel.tsx";
import { ListCanvas } from "./components/ListCanvas.tsx";
import { registerCanvas, registerFilterPanel, setDefaultCanvas } from "./slots.ts";

setDefaultCanvas(ListCanvas);
registerCanvas("list", ListCanvas);
registerCanvas("force-3d", Canvas3D); // lazy: three.js loads only when the map-3d view is opened
registerFilterPanel("map-3d", MapPanel);

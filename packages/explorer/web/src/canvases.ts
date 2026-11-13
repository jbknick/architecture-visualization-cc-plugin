// Registers the built-in canvas renderers. Later issues add their own imports here
// (for example a sigma 2D canvas, and a lazily imported 3D canvas).
import { ListCanvas } from "./components/ListCanvas.tsx";
import { registerCanvas, setDefaultCanvas } from "./slots.ts";

setDefaultCanvas(ListCanvas);
registerCanvas("list", ListCanvas);

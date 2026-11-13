import { lazy, Suspense } from "react";
import "./map3d.css";
import type { CanvasProps } from "../slots.ts";

// three.js lives in this lazy chunk; the main bundle only holds this file and the left panel.
const Graph3D = lazy(() => import("./Graph3D.tsx"));

export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export function WebglFallback() {
  return (
    <div className="map3d-fallback" role="alert">
      <h2>3D view needs WebGL</h2>
      <p>This browser cannot create a WebGL context, so the 3D map cannot be drawn.</p>
      <p>
        <a href="#/project-map">Open the 2D project map instead</a>
      </p>
    </div>
  );
}

export function Canvas3D(props: CanvasProps) {
  if (!webglAvailable()) return <WebglFallback />;
  return (
    <Suspense fallback={<p className="empty">Loading 3D view…</p>}>
      <Graph3D {...props} />
    </Suspense>
  );
}

import { lazy, Suspense } from "react";
import "./map3d.css";
import type { CanvasProps } from "../slots.ts";

// three.js lives in this lazy chunk; the main bundle only holds this file and the left panel.
const Graph3D = lazy(() => import("./Graph3D.tsx"));

let webglChecked: boolean | null = null;

/**
 * Whether this browser can create a WebGL context. Probed once per page and the probe context released at once:
 * this runs on every render of the 3D view (each hover re-renders it), and a probe per render used to pile up
 * contexts until the browser dropped the oldest live one, the scene's own, blanking the view until it was restored.
 */
export function webglAvailable(): boolean {
  if (webglChecked !== null) return webglChecked;
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    webglChecked = !!gl;
  } catch {
    webglChecked = false;
  }
  return webglChecked;
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

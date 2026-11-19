// The web app uses the same id functions as the server: this re-exports the one module (core/src/ids.ts has no imports,
// so the browser bundle takes nothing else from core). Nothing in the web app builds or splits an id by hand.
export * from "../../../core/src/ids.ts";

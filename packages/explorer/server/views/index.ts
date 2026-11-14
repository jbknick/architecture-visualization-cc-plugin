import type { ViewModule } from "../types.js";
import { debugView } from "./debug.js";
import { duplicatesView } from "./duplicates.js";
import { egoView } from "./ego.js";
import { map3dView } from "./map3d.js";
import { projectMapView } from "./projectMap.js";

const registry = new Map<string, ViewModule>();

export function registerView(view: ViewModule): void {
  registry.set(view.id, view);
}

export function getView(id: string): ViewModule | undefined {
  return registry.get(id);
}

export function listViews(): ViewModule[] {
  return [...registry.values()];
}

// Later issues add one file each and register it here.
registerView(debugView);
registerView(projectMapView);
registerView(egoView);
registerView(duplicatesView);
registerView(map3dView);

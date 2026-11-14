// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getCanvas } from "../slots.ts";
import { installMockFetch, renderApp } from "../testUtils.tsx";
import { CanvasHost } from "./CanvasHost.tsx";

// jsdom has no WebGL, so the sigma canvas is replaced by a stub; the real one runs in the Playwright tests.
vi.mock("./GraphCanvas.tsx", () => ({
  GraphCanvas: ({ nodes, viewId }: { nodes: unknown[]; viewId?: string | null }) => (
    <div data-testid="graph-stub">{`${nodes.length} nodes in ${viewId}`}</div>
  ),
}));

describe("graph canvas slot", () => {
  it("falls back to the list when WebGL is missing", async () => {
    installMockFetch();
    renderApp("#/canvas-demo");
    expect(await screen.findByRole("listbox", { name: "Graph nodes" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Graph" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("is registered for every 2D layout hint and keeps the list one click away", async () => {
    for (const hint of ["nested-elk", "elk-layered", "radial", "force", "tree-lr", "columns"]) {
      expect(getCanvas(hint)).toBe(CanvasHost);
    }
    // The duplicates view is a ranked list with a detail pane, so "clusters" has its own renderer.
    expect(getCanvas("clusters")).not.toBe(CanvasHost);
    expect(getCanvas("3d")).not.toBe(CanvasHost);

    vi.stubGlobal("WebGL2RenderingContext", class {});
    installMockFetch();
    renderApp("#/canvas-demo");
    const stub = await screen.findByTestId("graph-stub");
    expect(stub.textContent).toContain("in canvas-demo");

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(await screen.findByRole("listbox", { name: "Graph nodes" })).toBeTruthy();
    expect(screen.queryByTestId("graph-stub")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(await screen.findByTestId("graph-stub")).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { map3dView } from "../../mock/fixture.ts";
import { installMockFetch, renderApp } from "../testUtils.tsx";
import { Canvas3D } from "./index.tsx";
import { MapPanel } from "./MapPanel.tsx";
import { mapUi } from "./ui.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const noop = () => {};

describe("WebGL fallback", () => {
  it("shows a message linking to the 2D project map when WebGL is unavailable", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    render(
      <Canvas3D nodes={[]} edges={[]} layoutHint="force-3d" focus={null} onSelect={noop} onHover={noop} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("WebGL");
    expect(screen.getByRole("link", { name: /2D project map/ }).getAttribute("href")).toBe("#/project-map");
  });

  it("is what the shell renders for the map-3d view without WebGL", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    installMockFetch();
    renderApp("#/map-3d");
    expect(await screen.findByText("3D view needs WebGL")).toBeTruthy();
    expect(screen.getByLabelText("Hide tests")).toBeTruthy();
  });
});

describe("MapPanel", () => {
  const data = map3dView("dirs");
  const setup = (filters: Record<string, string> = {}) => {
    const onFiltersChange = vi.fn();
    render(
      <MapPanel
        viewId="map-3d"
        nodes={data.nodes}
        edges={data.edges}
        filters={filters}
        onFiltersChange={onFiltersChange}
      />,
    );
    return onFiltersChange;
  };

  it("switches level and keeps Folders as the default", () => {
    const change = setup();
    expect((screen.getByLabelText("Folders") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText("Files"));
    expect(change).toHaveBeenCalledWith({ level: "files" });
    fireEvent.click(screen.getByLabelText("Workspaces"));
    expect(change).toHaveBeenLastCalledWith({ level: "workspaces" });
  });

  it("hides tests by default and toggles the filter", () => {
    const change = setup();
    const box = screen.getByLabelText("Hide tests") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(change).toHaveBeenCalledWith({ tests: "show" });
  });

  it("lists workspaces with kind and counts; clicking a row focuses that island", () => {
    setup();
    const row = screen.getByRole("button", { name: /@acme\/web/ });
    expect(row.textContent).toMatch(/app · \d+ fn · 22 files/);
    fireEvent.click(row);
    expect(mapUi.get().island).toBe("ws:@acme/web");
    expect(mapUi.get().flyNonce).toBeGreaterThan(0);
  });

  it("Reset camera bumps the reset request and clears the island", () => {
    setup();
    const before = mapUi.get().resetNonce;
    fireEvent.click(screen.getByRole("button", { name: "Reset camera" }));
    expect(mapUi.get().resetNonce).toBe(before + 1);
    expect(mapUi.get().island).toBeNull();
  });

  it("auto-rotate toggle writes to the shared store", () => {
    setup();
    const box = screen.getByLabelText(/Auto-rotate/) as HTMLInputElement;
    const before = mapUi.get().autoRotate;
    fireEvent.click(box);
    expect(mapUi.get().autoRotate).toBe(!before);
  });
});

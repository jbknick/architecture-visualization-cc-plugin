// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { map3dView } from "../../mock/fixture.ts";
import type { ViewLevel } from "../api.ts";
import { emptyRoute } from "../route.ts";
import { installMockFetch, renderApp } from "../testUtils.tsx";
import { Canvas3D } from "./index.tsx";
import { MapPanel } from "./MapPanel.tsx";
import { mapUi, readStyle } from "./ui.ts";

beforeEach(() => {
  window.localStorage.clear();
});

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
    expect(screen.getByRole("tab", { name: "3D map" }).getAttribute("aria-selected")).toBe("true");
    // The function-kind legend does not apply to this view; the panel has its own "how to read it" block.
    expect(screen.queryByText("Legend")).toBeNull();
    expect(screen.getByText("How to read it")).toBeTruthy();
  });
});

describe("MapPanel (islands style)", () => {
  beforeEach(() => window.localStorage.setItem("gantry.map3d.style", "islands"));
  const data = map3dView("dirs");
  const setup = (filters: Record<string, string> = {}, level: ViewLevel | null = null) => {
    const onFiltersChange = vi.fn();
    const onRouteChange = vi.fn();
    render(
      <MapPanel
        viewId="map-3d"
        nodes={data.nodes}
        edges={data.edges}
        filters={filters}
        onFiltersChange={onFiltersChange}
        route={{ ...emptyRoute, view: "map-3d", level, filters }}
        onRouteChange={onRouteChange}
      />,
    );
    return { onFiltersChange, onRouteChange };
  };

  it("switches level and keeps Folders as the default", () => {
    const { onRouteChange } = setup();
    expect((screen.getByLabelText("Folders") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText("Files"));
    expect(onRouteChange).toHaveBeenCalledWith({ level: "files" });
    fireEvent.click(screen.getByLabelText("Workspaces"));
    expect(onRouteChange).toHaveBeenLastCalledWith({ level: "workspaces" });
  });

  it("puts the legend (island, arrow, sphere) right under the level switch, before the toggles", () => {
    setup();
    const levels = document.querySelector(".map3d-levels") as Element;
    const howto = document.querySelector(".map3d-howto") as Element;
    const hide = screen.getByLabelText("Hide tests");
    const list = document.querySelector(".map3d-legend") as Element;
    const precedes = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(precedes(levels, howto)).toBe(true);
    expect(precedes(howto, hide)).toBe(true);
    expect(precedes(howto, list)).toBe(true);
    expect(howto.textContent).toContain("Island = one workspace");
    expect(howto.textContent).toContain("Arrow A → B = A imports from B");
    expect(howto.textContent).toContain("folder");
  });

  it('collapses "How to read it" to one line, remembers the choice, and starts collapsed after the first view', () => {
    setup();
    const toggle = screen.getByRole("button", { name: /How to read it/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true"); // first view, 5 workspaces: open
    expect(document.querySelector(".map3d-howto ul")).not.toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".map3d-howto ul")).toBeNull();
    expect(window.localStorage.getItem("gantry.map3d.howto")).toBe("collapsed");
    cleanup();
    setup(); // remembered
    expect(screen.getByRole("button", { name: /How to read it/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: /How to read it/ }));
    expect(window.localStorage.getItem("gantry.map3d.howto")).toBe("open");
    cleanup();
    setup();
    expect(screen.getByRole("button", { name: /How to read it/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("starts collapsed on a second visit, with no saved choice", () => {
    setup(); // first view marks the visit as seen
    expect(window.localStorage.getItem("gantry.map3d.howto-seen")).toBe("1");
    cleanup();
    setup();
    expect(screen.getByRole("button", { name: /How to read it/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("hides tests by default and toggles the filter", () => {
    const { onFiltersChange } = setup();
    const box = screen.getByLabelText("Hide tests") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(onFiltersChange).toHaveBeenCalledWith({ hideTests: "false" });
  });

  it("reads the level from the route and shows tests when hideTests is false", () => {
    setup({ hideTests: "false" }, "files");
    expect((screen.getByLabelText("Files") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Hide tests") as HTMLInputElement).checked).toBe(false);
  });

  it("lists workspaces with kind and counts; clicking a row focuses that island", () => {
    setup();
    const row = screen.getByRole("button", { name: /^web/ });
    expect(row.getAttribute("title")).toBe("@acme/web");
    expect(row.textContent).toMatch(/web\d+ fnapp · 22 files/);
    fireEvent.click(row);
    expect(mapUi.get().island).toBe("ws:@acme/web");
    expect(mapUi.get().flyNonce).toBeGreaterThan(0);
  });

  it("sorts the legend by function count, biggest first, and hover highlights the island", () => {
    setup();
    const rows = [...document.querySelectorAll(".map3d-legend-row")];
    expect(rows).toHaveLength(5);
    const counts = rows.map((r) =>
      Number.parseInt((r.querySelector(".map3d-legend-count")?.textContent ?? "").replace(/,/g, ""), 10),
    );
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    const row = screen.getByRole("button", { name: /^web/ });
    fireEvent.mouseEnter(row);
    expect(mapUi.get().hoverIsland).toBe("ws:@acme/web");
    fireEvent.mouseLeave(row);
    expect(mapUi.get().hoverIsland).toBeNull();
  });

  it("declared dependencies are hidden by default and toggle through the store", () => {
    setup();
    expect(mapUi.get().showDeclared).toBe(false);
    fireEvent.click(screen.getByLabelText("Show declared dependencies"));
    expect(mapUi.get().showDeclared).toBe(true);
  });

  it("auto-rotate starts off", () => {
    expect(mapUi.get().autoRotate).toBe(false);
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

describe("style and camera controls (city is the default)", () => {
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
        route={{ ...emptyRoute, view: "map-3d", filters }}
        onRouteChange={vi.fn()}
      />,
    );
    return { onFiltersChange };
  };

  it("reads the style from the hash, then from localStorage, and defaults to the city", () => {
    expect(readStyle({})).toBe("city");
    expect(readStyle({ style: "islands" })).toBe("islands");
    window.localStorage.setItem("gantry.map3d.style", "islands");
    expect(readStyle({})).toBe("islands");
    expect(readStyle({ style: "city" })).toBe("city");
  });

  it("shows City selected by default and explains the city in 'How to read it'", () => {
    setup();
    expect((screen.getByLabelText("City") as HTMLInputElement).checked).toBe(true);
    const howto = document.querySelector(".map3d-howto") as Element;
    expect(howto.textContent).toContain("District = one workspace");
    expect(howto.textContent).toContain("Arch A → B = A imports from B");
  });

  it("switches to Islands through the hash filter and remembers the choice; City drops the filter", () => {
    const { onFiltersChange } = setup({ hideTests: "false" });
    fireEvent.click(screen.getByLabelText("Islands"));
    expect(onFiltersChange).toHaveBeenCalledWith({ hideTests: "false", style: "islands" });
    expect(window.localStorage.getItem("gantry.map3d.style")).toBe("islands");
    cleanup();
    const again = setup({ style: "islands", hideTests: "false" });
    fireEvent.click(screen.getByLabelText("City"));
    expect(again.onFiltersChange).toHaveBeenCalledWith({ hideTests: "false" });
    expect(window.localStorage.getItem("gantry.map3d.style")).toBe("city");
  });

  it("has Top view, Angled view and Reset camera buttons that send camera requests", () => {
    setup();
    const before = mapUi.get().cameraNonce;
    fireEvent.click(screen.getByRole("button", { name: "Top view" }));
    expect(mapUi.get().cameraView).toBe("top");
    expect(mapUi.get().cameraNonce).toBe(before + 1);
    fireEvent.click(screen.getByRole("button", { name: "Angled view" }));
    expect(mapUi.get().cameraView).toBe("angled");
    fireEvent.click(screen.getByRole("button", { name: "Reset camera" }));
    expect(mapUi.get().cameraView).toBe("reset");
    expect(mapUi.get().cameraNonce).toBe(before + 3);
  });

  it("does not show the camera preset buttons in the islands style", () => {
    setup({ style: "islands" });
    expect(screen.queryByRole("button", { name: "Top view" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reset camera" })).toBeTruthy();
  });
});

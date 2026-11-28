// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphNode, ViewData } from "../api.ts";
import { emptyRoute } from "../route.ts";
import { PagesPanel } from "./PagesPanel.tsx";
import { SlicesPanel } from "./SlicesPanel.tsx";

afterEach(cleanup);

const route = (id: string, label: string): GraphNode => ({ id, kind: "route", label, size: 1 });
const nodes: GraphNode[] = [
  route("route:pnpm-turbo:@a/web:/", "/"),
  route("route:pnpm-turbo:@a/web:/posts", "/posts"),
  { id: "sym:pnpm-turbo:b.tsx#Button", kind: "component", label: "Button", size: 1, badges: ["shared by 2"] },
];
const data = (over: Partial<ViewData> = {}): ViewData => ({
  nodes,
  edges: [],
  layoutHint: "tree-lr",
  apps: [
    { id: "ws:@a/web", name: "@a/web", shortLabel: "web", routes: 2 },
    { id: "ws:@a/admin", name: "@a/admin", shortLabel: "admin", routes: 1 },
  ],
  ...over,
});

describe("PagesPanel", () => {
  const base = {
    viewId: "pages",
    nodes,
    edges: [],
    filters: {},
    onFiltersChange: vi.fn(),
    route: emptyRoute,
  };

  it("counts routes, lists shared components and changes the steps", () => {
    const onRouteChange = vi.fn();
    render(<PagesPanel {...base} data={data()} onRouteChange={onRouteChange} />);
    expect(screen.getByText(/2 routes, each with the component it serves/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Button/ })).toBeTruthy();
    fireEvent.change(screen.getByRole("slider"), { target: { value: "3" } });
    expect(onRouteChange).toHaveBeenCalledWith({ hops: 3 });
    expect((screen.getByRole("slider") as HTMLInputElement).value).toBe("2");
  });

  it("filters by app and by route prefix", () => {
    const onFiltersChange = vi.fn();
    render(<PagesPanel {...base} data={data()} onFiltersChange={onFiltersChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /admin/ }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({ app: "ws:@a/web" });
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "/settings" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ prefix: "/settings" });
  });

  it("says so when there are no routes", () => {
    render(<PagesPanel {...base} nodes={[]} data={data({ nodes: [], apps: [] })} />);
    expect(screen.getByText(/No routes found/)).toBeTruthy();
  });
});

describe("SlicesPanel", () => {
  const slice = (id: string): GraphNode => ({ id, kind: "slice", label: id, size: 1 });
  const base = { viewId: "slices", edges: [], filters: {}, onFiltersChange: vi.fn(), route: emptyRoute };
  const sliceData = (): ViewData =>
    data({
      layoutHint: "nested-elk",
      edges: [
        {
          id: "a|imports|b",
          src: "slice:a",
          dst: "slice:b",
          kind: "imports",
          weight: 2,
          confidence: "high",
          cross: true,
        },
      ],
      shared: [
        {
          id: "sym:pnpm-turbo:ui#Button",
          name: "Button",
          kind: "component",
          path: "ui/button.tsx",
          slice: "slice:ui",
          usedBy: [
            { id: "slice:a", label: "a" },
            { id: "slice:b", label: "b" },
          ],
        },
      ],
      routeFallback: ["ws:@a/web"],
    });

  it("summarizes slices and links, lists what is shared and notes the route fallback", () => {
    render(
      <SlicesPanel
        {...base}
        nodes={[slice("slice:a"), slice("slice:b")]}
        data={sliceData()}
        onRouteChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/2 slices; 1 link between them/)).toBeTruthy();
    expect(screen.getByText(/first-level route segments/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Button/ }).textContent).toContain("2 slices");
  });

  it("changes the level and toggles imports inside a slice", () => {
    const onRouteChange = vi.fn();
    const onFiltersChange = vi.fn();
    render(
      <SlicesPanel
        {...base}
        nodes={[slice("slice:a")]}
        data={sliceData()}
        onRouteChange={onRouteChange}
        onFiltersChange={onFiltersChange}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Functions" }));
    expect(onRouteChange).toHaveBeenLastCalledWith({ level: "symbols" });
    fireEvent.click(screen.getByRole("radio", { name: "Files" }));
    expect(onRouteChange).toHaveBeenLastCalledWith({ level: null });
    fireEvent.click(screen.getByRole("checkbox", { name: /Imports inside a slice/ }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({ intra: "true" });
  });
});

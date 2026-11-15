// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { overlayNodes, reviewNodes } from "../../mock/review.ts";
import "../canvases.ts";
import { installMockFetch, renderApp } from "../testUtils.tsx";
import { labelRing, layoutOverlay, OVERLAY_SIZE, ringBounds, ringRadii, shortName } from "./reviewModel.ts";

const BUTTON = "sym:packages/ui/src/button.tsx#Button";

describe("reviewModel", () => {
  it("names, ring radii and bounds from the server positions", () => {
    expect(shortName(BUTTON)).toBe("Button");
    expect(shortName("file:a/b/c.ts")).toBe("c.ts");
    const nodes = reviewNodes();
    expect(ringRadii(nodes).map((r) => [r.hop, Math.round(r.r), r.count])).toEqual([
      [0, 70, 3],
      [1, 220, 3],
      [2, 370, 2],
    ]);
    const b = ringBounds(nodes);
    expect(b.w).toBe(b.h);
    expect(-b.x).toBeGreaterThan(370);
    expect(labelRing(0, 30)).toBe(true);
    expect(labelRing(0, 31)).toBe(false);
    expect(labelRing(1, 41)).toBe(false);
    expect(labelRing(2, 24)).toBe(true);
  });

  it("overlay: one box per workspace, every file tiled inside its box, the same output for shuffled input", () => {
    const nodes = overlayNodes();
    const boxes = layoutOverlay(nodes);
    expect(boxes.map((b) => b.id)).toEqual([
      "ws:@acme/api",
      "ws:@acme/db",
      "ws:@acme/ui",
      "ws:@acme/utils",
      "ws:@acme/web",
    ]);
    for (const b of boxes) {
      expect(b.rect.x + b.rect.w).toBeLessThanOrEqual(OVERLAY_SIZE.w + 0.01);
      expect(b.rect.y + b.rect.h).toBeLessThanOrEqual(OVERLAY_SIZE.h + 0.01);
      for (const f of b.files) {
        expect(f.rect.x).toBeGreaterThanOrEqual(b.rect.x - 0.01);
        expect(f.rect.x + f.rect.w).toBeLessThanOrEqual(b.rect.x + b.rect.w + 0.01);
        expect(f.rect.y + f.rect.h).toBeLessThanOrEqual(b.rect.y + b.rect.h + 0.01);
      }
    }
    expect(boxes.find((b) => b.id === "ws:@acme/web")).toMatchObject({ changed: 0, affected: 3 });
    expect(layoutOverlay([...nodes].reverse())).toEqual(boxes);
  });
});

describe("review view", () => {
  it("asks for a range when none is given", async () => {
    installMockFetch();
    renderApp("#/review");
    expect(await screen.findByRole("heading", { name: "Pick a change to review" })).toBeTruthy();
  });

  it("rings: changed symbols, callers and the left panel's risk, files, crossings and notes", async () => {
    installMockFetch();
    renderApp("#/review?range=main...feature");
    const canvas = await screen.findByTestId("review-canvas");
    await waitFor(() => expect(canvas.getAttribute("data-mode")).toBe("rings"));
    expect(within(canvas).getByRole("button", { name: "Button, modified" })).toBeTruthy();
    expect(within(canvas).getByRole("button", { name: "slugify, removed" })).toBeTruthy();
    expect(within(canvas).getByRole("button", { name: "HomePage, hop 1 callers" })).toBeTruthy();
    expect(within(canvas).getByText("Hop 2 callers (2)")).toBeTruthy();

    const risk = screen.getByRole("region", { name: "Risk" });
    expect(within(risk).getByText("Medium risk")).toBeTruthy();
    expect(within(risk).getByText("56/100")).toBeTruthy();
    expect(within(risk).getByText("+30 signature changed on an exported symbol")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Changed files" })).getAllByRole("button")).toHaveLength(
      3,
    );
    expect(within(screen.getByRole("region", { name: "Crossings" })).getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("region", { name: "Notes" }).textContent).toContain("left-pad");
  });

  it("clicking a changed symbol in the panel opens it in the inspector with its signature before and after", async () => {
    installMockFetch();
    renderApp("#/review?range=main...feature");
    const list = await screen.findByRole("region", { name: "Changed symbols" });
    fireEvent.click(within(list).getByRole("button", { name: /Button/ }));
    const inspector = await screen.findByRole("complementary", { name: "Inspector" });
    const change = within(inspector).getByRole("region", { name: "Change in this review" });
    expect(change.querySelector('[data-side="before"]')?.textContent).toContain("onClick?: () => void })");
    expect(change.querySelector('[data-side="after"]')?.textContent).toContain("size?: number");
    expect(within(change).getByText("Renders a labelled button.")).toBeTruthy();
    expect(window.location.hash).toContain(`sel=${encodeURIComponent(BUTTON)}`);
  });

  it("a deep link with focus opens that symbol; a renamed one shows both names", async () => {
    installMockFetch();
    renderApp(
      `#/review?range=main...feature&focus=${encodeURIComponent("sym:packages/utils/src/date.ts#formatTimeAgo")}`,
    );
    const inspector = await screen.findByRole("complementary", { name: "Inspector" });
    const change = await within(inspector).findByRole("region", { name: "Change in this review" });
    expect(within(change).getByText("Renamed")).toBeTruthy();
    expect(change.querySelector('[data-side="before"]')?.textContent).toContain("formatRelativeDate");
  });

  it("the range form and the mode toggle write the hash; overlay dims what is not affected", async () => {
    installMockFetch();
    renderApp("#/review?range=main...feature");
    await screen.findByRole("region", { name: "Risk" });
    fireEvent.click(screen.getByRole("radio", { name: "Map overlay" }));
    await waitFor(() => expect(window.location.hash).toContain("mode=overlay"));
    const canvas = await screen.findByTestId("review-canvas");
    await waitFor(() => expect(canvas.getAttribute("data-mode")).toBe("overlay"));
    expect(canvas.querySelectorAll('[data-mark="changed"]')).toHaveLength(2);
    expect(canvas.querySelectorAll('[data-mark="affected"]')).toHaveLength(4);
    expect(canvas.querySelectorAll('[data-mark="none"]').length).toBeGreaterThan(0);

    const input = screen.getByRole("textbox", { name: "Range to review" });
    fireEvent.change(input, { target: { value: "main...other" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(window.location.hash).toContain("range=main...other"));
  });

  it("shows the server's message for a bad range", async () => {
    installMockFetch();
    renderApp("#/review?range=main");
    expect(await screen.findByRole("heading", { name: "This view could not be loaded" })).toBeTruthy();
    expect((await screen.findAllByText(/expected <base>...<head>, got "main"/)).length).toBeGreaterThan(0);
  });
});

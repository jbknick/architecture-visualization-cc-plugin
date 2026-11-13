// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { nodeDetails } from "../mock/fixture.ts";
import { ListCanvas } from "./components/ListCanvas.tsx";
import "./canvases.ts";
import type { GraphNode } from "./api.ts";
import { getCanvas, registerCanvas } from "./slots.ts";
import { installMockFetch, renderApp } from "./testUtils.tsx";

const BUTTON = "sym:packages/ui/src/button.tsx#Button";
const deepLink = (id: string) => `#/debug?focus=${encodeURIComponent(id)}`;

describe("shell", () => {
  it("shows repo, short sha, view tabs and status counts from /api/meta", async () => {
    installMockFetch();
    renderApp();
    expect(await screen.findByText("pnpm-turbo")).toBeTruthy();
    expect(screen.getByText("a1b2c3d")).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toContain("Architecture");
    const disabled = screen.getByRole("tab", { name: "Architecture" });
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    expect(disabled.getAttribute("title")).toMatch(/not available/i);
    expect(await screen.findByText(/Backlog: 12/)).toBeTruthy();
    expect(screen.getByText(/Working changes: 2 files/)).toBeTruthy();
  });

  it("lands on the first enabled view and renders its nodes in the placeholder list", async () => {
    installMockFetch();
    renderApp();
    expect(await screen.findByText("@acme/web")).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#/debug"));
    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBeNull();
  });

  it("ignores clicks on disabled tabs", async () => {
    installMockFetch();
    renderApp();
    fireEvent.click(await screen.findByRole("tab", { name: "Request flow" }));
    await waitFor(() => expect(window.location.hash).toBe("#/debug"));
  });
});

describe("routing", () => {
  it("opens the inspector for a deep link on load", async () => {
    installMockFetch();
    renderApp(deepLink(BUTTON));
    const inspector = await screen.findByRole("complementary", { name: "Inspector" });
    expect(await within(inspector).findByText(/function Button\(/)).toBeTruthy();
    expect(within(inspector).getByText("Generated description — may be wrong")).toBeTruthy();
    expect(within(inspector).getByText(/Source: model \(claude-haiku\)/)).toBeTruthy();
    expect(within(inspector).getByText("packages/ui/src/button.tsx:1")).toBeTruthy();
    expect(within(inspector).getByText("Fan-in")).toBeTruthy();
    await waitFor(() => expect(within(inspector).getByLabelText(/Source of/)).toBeTruthy());
  });

  it("follows hash changes (back/forward) and closes the inspector when focus is cleared", async () => {
    installMockFetch();
    renderApp(deepLink(BUTTON));
    await screen.findByRole("complementary", { name: "Inspector" });
    await act(async () => {
      window.location.hash = "#/debug";
    });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Inspector" })).toBeNull());
  });

  it("clicking a list row focuses it in the hash", async () => {
    installMockFetch();
    renderApp();
    const row = await screen.findByRole("option", { name: /@acme\/ui/ });
    fireEvent.click(row);
    expect(window.location.hash).toContain("focus=ws%3A%40acme%2Fui");
  });

  it("clicking a neighbor in the inspector navigates to it", async () => {
    installMockFetch();
    renderApp(deepLink("sym:apps/web/src/components/PostList.tsx#PostList"));
    const inspector = await screen.findByRole("complementary", { name: "Inspector" });
    const neighbor = await within(inspector).findByRole("button", { name: "Card" });
    fireEvent.click(neighbor);
    expect(decodeURIComponent(window.location.hash)).toContain("focus=sym:packages/ui/src/card.tsx#Card");
  });
});

describe("search", () => {
  it("shows results from /api/search and Enter focuses the first hit", async () => {
    installMockFetch();
    renderApp();
    const box = await screen.findByRole("combobox", { name: "Search symbols" });
    fireEvent.change(box, { target: { value: "Butt" } });
    const option = await screen.findByRole("option", { name: /Button/ });
    expect(option.textContent).toContain("packages/ui/src/button.tsx:1");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(decodeURIComponent(window.location.hash)).toContain(`focus=${BUTTON}`));
    expect(await screen.findByRole("complementary", { name: "Inspector" })).toBeTruthy();
  });

  it("Ctrl+K and Cmd+K focus the search box", async () => {
    installMockFetch();
    renderApp();
    const box = await screen.findByRole("combobox", { name: "Search symbols" });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(document.activeElement).toBe(box);
    (box as HTMLInputElement).blur();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(box);
  });

  it("says so when nothing matches", async () => {
    installMockFetch();
    renderApp();
    const box = await screen.findByRole("combobox", { name: "Search symbols" });
    fireEvent.change(box, { target: { value: "zzzz" } });
    expect(await screen.findByText("No matches")).toBeTruthy();
  });
});

describe("inspector safety", () => {
  it("renders a description containing HTML as plain text", async () => {
    const evil = '<img src=x onerror="window.__pwned = true"><script>window.__pwned = true</script>';
    installMockFetch((url) => {
      if (url.pathname.startsWith("/api/node/")) {
        const base = nodeDetails[BUTTON];
        return { status: 200, body: { ...base, untrusted_description: evil } };
      }
    });
    const { container } = renderApp(deepLink(BUTTON));
    const inspector = await screen.findByRole("complementary", { name: "Inspector" });
    await within(inspector).findByText(evil);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("says 'Not yet described' when there is no description", async () => {
    installMockFetch();
    renderApp(deepLink("sym:packages/ui/src/card.tsx#Card"));
    expect(await screen.findByText("Not yet described")).toBeTruthy();
  });
});

const Custom = () => <div>custom canvas</div>;

describe("canvas slot", () => {
  const manyNodes = (n: number): GraphNode[] =>
    Array.from({ length: n }, (_, i) => ({ id: `n${i}`, kind: "function", label: `fn${i}`, size: 1 }));

  it("virtualizes the placeholder list", () => {
    render(
      <ListCanvas
        nodes={manyNodes(5000)}
        edges={[]}
        layoutHint="list"
        focus={null}
        onSelect={() => {}}
        onHover={() => {}}
      />,
    );
    const rows = screen.getAllByRole("option");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(60);
  });

  it("uses the renderer registered for a layoutHint and falls back to the list otherwise", () => {
    registerCanvas("force", Custom);
    expect(getCanvas("force")).toBe(Custom);
    expect(getCanvas("never-registered")).toBe(ListCanvas);
  });
});

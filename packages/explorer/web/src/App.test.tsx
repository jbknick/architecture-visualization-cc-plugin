// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ids, nodeDetails } from "../mock/fixture.ts";
import { ListCanvas } from "./components/ListCanvas.tsx";
import "./canvases.ts";
import type { GraphNode } from "./api.ts";
import { getCanvas, registerCanvas } from "./slots.ts";
import { installMockFetch, renderApp } from "./testUtils.tsx";

const BUTTON = ids.button;
const deepLink = (id: string, view = "project-map") => `#/${view}?sel=${encodeURIComponent(id)}`;
const inspectorOf = () => screen.findByRole("complementary", { name: "Inspector" });

describe("shell", () => {
  it("shows repo, short sha, view tabs and the counts the real server sends", async () => {
    installMockFetch();
    renderApp();
    expect(await screen.findByText("pnpm-turbo")).toBeTruthy();
    expect(screen.getByText("a1b2c3d")).toBeTruthy();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Debug: workspaces",
      "Project map",
      "Function ego graph",
      "3D map",
    ]);
    expect(await screen.findByText("5 workspaces")).toBeTruthy();
    expect(screen.getByText("9 files")).toBeTruthy();
    expect(screen.getByText("31 edges indexed")).toBeTruthy();
  });

  it("hides the backlog and working-changes items when the server does not report them", async () => {
    installMockFetch();
    renderApp();
    await screen.findByText("5 workspaces");
    expect(screen.queryByText(/Backlog/)).toBeNull();
    expect(screen.queryByText(/Working changes/)).toBeNull();
  });

  it("shows them when the server does report them", async () => {
    installMockFetch((url) => {
      if (url.pathname === "/api/meta") {
        return {
          status: 200,
          body: {
            repo: "r",
            headSha: null,
            counts: { workspaces: 1, files: 1, symbols: 1, edges: 1, backlog: 12, workingFiles: 2 },
            views: [{ id: "debug", title: "Debug", enabled: true }],
          },
        };
      }
    });
    renderApp();
    expect(await screen.findByText("Backlog: 12")).toBeTruthy();
    expect(screen.getByText("Working changes: 2 files")).toBeTruthy();
  });

  it("lands on the project map and renders its nodes in the placeholder list", async () => {
    installMockFetch();
    renderApp();
    expect(await screen.findByRole("option", { name: /@acme\/web/ })).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#/project-map"));
    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBeNull();
  });

  it("shows a readable error with a reset button when a view fails", async () => {
    installMockFetch((url) =>
      url.pathname.startsWith("/api/view/project-map")
        ? { status: 404, body: { error: "Unknown focus: file:gone.ts" } }
        : undefined,
    );
    renderApp("#/project-map?focus=file%3Agone.ts");
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("This view could not be loaded")).toBeTruthy();
    expect(within(alert).getByText("Unknown focus: file:gone.ts")).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Reset this view" })).toBeTruthy();
  });
});

describe("routing", () => {
  it("opens the inspector for a deep link on load and shows the real node shape", async () => {
    installMockFetch();
    renderApp(deepLink(BUTTON));
    const inspector = await inspectorOf();
    expect(await within(inspector).findByText(/function Button\(/)).toBeTruthy();
    expect(within(inspector).getByText("Generated description — may be wrong")).toBeTruthy();
    expect(within(inspector).getByText("packages/ui/src/button.tsx:2")).toBeTruthy();
    expect(within(inspector).getByText("Used by")).toBeTruthy();
    await waitFor(() => expect(within(inspector).getByLabelText(/Source of/)).toBeTruthy());
  });

  it("groups neighbors by connection type and direction, with plain-word titles", async () => {
    installMockFetch();
    renderApp(deepLink(BUTTON));
    const inspector = await inspectorOf();
    expect(await within(inspector).findByText("Rendered by")).toBeTruthy();
    expect(within(inspector).getByRole("button", { name: "PostList" })).toBeTruthy();
    expect(within(inspector).getByText("Part of")).toBeTruthy();
  });

  it("follows hash changes (back/forward) and closes the inspector when the selection is cleared", async () => {
    installMockFetch();
    renderApp(deepLink(BUTTON));
    await inspectorOf();
    await act(async () => {
      window.location.hash = "#/project-map";
    });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Inspector" })).toBeNull());
  });

  it("clicking a list row selects it in the hash without changing the view's focus", async () => {
    installMockFetch();
    renderApp();
    const row = await screen.findByRole("option", { name: /@acme\/ui/ });
    fireEvent.click(row);
    expect(window.location.hash).toContain("sel=ws%3A%40acme%2Fui");
    expect(window.location.hash).not.toContain("focus=");
  });

  it("clicking a neighbor in the inspector selects it", async () => {
    installMockFetch();
    renderApp(deepLink(ids.postList));
    const inspector = await inspectorOf();
    const neighbor = await within(inspector).findByRole("button", { name: "Card" });
    fireEvent.click(neighbor);
    expect(decodeURIComponent(window.location.hash)).toContain(`sel=${ids.card}`);
  });
});

describe("inspector for nodes the server does not know", () => {
  it("builds a folder from the view's own node, without calling /api/node", async () => {
    const { calls } = installMockFetch();
    renderApp(deepLink(ids.uiSrcDir));
    const inspector = await inspectorOf();
    expect(await within(inspector).findByText(/A folder/)).toBeTruthy();
    expect(within(inspector).getByText("Lines of code")).toBeTruthy();
    expect(within(inspector).getByText("packages/ui/src")).toBeTruthy();
    expect(calls.some((c) => c.startsWith("/api/node/"))).toBe(false);
    expect(within(inspector).queryByText(/Could not load/)).toBeNull();
  });

  it("explains a '+K more' node and an npm package", async () => {
    const view = {
      nodes: [
        { id: "more:out:2:*", kind: "more", label: "+7 more", size: 7, side: "out", hop: 2 },
        { id: "ext:react", kind: "external", label: "react", size: 3 },
      ],
      edges: [],
      layoutHint: "list",
    };
    const { calls } = installMockFetch((url) =>
      url.pathname.startsWith("/api/view/project-map") ? { status: 200, body: view } : undefined,
    );
    renderApp(deepLink("more:out:2:*"));
    const inspector = await inspectorOf();
    expect(await within(inspector).findByText(/7 more connected functions are hidden/)).toBeTruthy();
    expect(calls.some((c) => c.startsWith("/api/node/"))).toBe(false);
    await act(async () => {
      window.location.hash = deepLink("ext:react");
    });
    expect(await within(inspector).findByText(/An npm package. 3 of your files import it/)).toBeTruthy();
  });

  it("falls back to the view's node when /api/node fails for a known id", async () => {
    installMockFetch((url) =>
      url.pathname.startsWith("/api/node/") ? { status: 500, body: { error: "boom" } } : undefined,
    );
    renderApp(deepLink("file:packages/ui/src/card.tsx"));
    const inspector = await inspectorOf();
    expect(await within(inspector).findByText(/Could not load the full details/)).toBeTruthy();
    expect(within(inspector).getByRole("heading", { name: "card.tsx" })).toBeTruthy();
  });
});

describe("inspector actions", () => {
  it("'Open in project map' focuses the file that holds a function", async () => {
    installMockFetch();
    renderApp(deepLink(BUTTON, "ego"));
    const inspector = await inspectorOf();
    fireEvent.click(await within(inspector).findByRole("button", { name: "Open in project map" }));
    expect(decodeURIComponent(window.location.hash)).toContain(
      "#/project-map?focus=file:packages/ui/src/button.tsx",
    );
  });

  it("'Show callers & callees' switches to the ego view centred on the node", async () => {
    installMockFetch();
    renderApp(deepLink(BUTTON));
    const inspector = await inspectorOf();
    fireEvent.click(await within(inspector).findByRole("button", { name: "Show callers & callees" }));
    expect(decodeURIComponent(window.location.hash)).toContain(`#/ego?focus=${BUTTON}`);
  });

  it("disables 'Show callers & callees' for folders but keeps 'Open in project map'", async () => {
    installMockFetch();
    renderApp(deepLink(ids.uiSrcDir));
    const inspector = await inspectorOf();
    const ego = await within(inspector).findByRole("button", { name: "Show callers & callees" });
    expect((ego as HTMLButtonElement).disabled).toBe(true);
    expect(
      (within(inspector).getByRole("button", { name: "Open in project map" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("search", () => {
  it("shows results from /api/search and Enter selects the first hit", async () => {
    installMockFetch();
    renderApp();
    const box = await screen.findByRole("combobox", { name: "Search symbols" });
    fireEvent.change(box, { target: { value: "Butt" } });
    const option = await screen.findByRole("option", { name: /Button/ });
    expect(option.textContent).toContain("packages/ui/src/button.tsx:2");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(decodeURIComponent(window.location.hash)).toContain(`sel=${BUTTON}`));
    expect(await inspectorOf()).toBeTruthy();
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
    const inspector = await inspectorOf();
    await within(inspector).findByText(evil);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("says 'Not yet described' when the server sends a null description", async () => {
    installMockFetch();
    renderApp(deepLink(ids.card));
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

  it("double-click calls onDrill", () => {
    const drilled: string[] = [];
    render(
      <ListCanvas
        nodes={manyNodes(3)}
        edges={[]}
        layoutHint="list"
        focus={null}
        onSelect={() => {}}
        onHover={() => {}}
        onDrill={(id) => drilled.push(id)}
      />,
    );
    fireEvent.doubleClick(screen.getByRole("option", { name: /fn1/ }));
    expect(drilled).toEqual(["n1"]);
  });

  it("uses the renderer registered for a layoutHint and falls back to the list otherwise", () => {
    registerCanvas("force", Custom);
    expect(getCanvas("force")).toBe(Custom);
    expect(getCanvas("never-registered")).toBe(ListCanvas);
  });
});

// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { handleMockApi, ids } from "../mock/fixture.ts";
import type { GraphNode, RefreshResult, ViewData } from "./api.ts";
import { freshIds, refreshStore } from "./refresh.ts";
import { installMockFetch, renderApp } from "./testUtils.tsx";

afterEach(() => refreshStore.reset());

const ADDED = "sym:packages/ui/src/button.tsx#refreshedHelper";

/** The mock API with an editable working tree: `edit()` makes one file stale; a refresh adds a function to it. */
function editableMock() {
  let edited = false;
  let refreshed = false;
  let refreshCalls = 0;
  const result: RefreshResult = {
    changed: { files: 1, functions: 1 },
    ms: 12,
    healed: false,
    files: [ids.buttonFile],
    functions: { added: [ADDED], changed: [], removed: [] },
  };
  const { calls } = installMockFetch((url) => {
    if (url.pathname === "/api/refresh") {
      refreshCalls++;
      refreshed = true;
      return { status: 200, body: result };
    }
    const stale = { files: edited && !refreshed ? 1 : 0 };
    const base = handleMockApi(url);
    if (base?.status !== 200) return base;
    if (url.pathname === "/api/meta") return { status: 200, body: { ...(base.body as object), stale } };
    if (url.pathname.startsWith("/api/view/")) {
      const view = base.body as ViewData;
      const nodes: GraphNode[] =
        refreshed && view.nodes.some((n) => n.id === ids.buttonFile)
          ? [
              ...view.nodes,
              { id: ADDED, kind: "function", label: "refreshedHelper", parent: ids.buttonFile, size: 1 },
            ]
          : view.nodes;
      return { status: 200, body: { ...view, nodes, stale } };
    }
    return undefined;
  });
  return {
    calls,
    edit: () => {
      edited = true;
    },
    refreshCalls: () => refreshCalls,
  };
}

describe("refresh on request (spec section 11 (c))", () => {
  it("shows the marker on the next request after a save, refreshes in place and highlights what changed", async () => {
    const mock = editableMock();
    renderApp(`#/project-map?level=symbols&sel=${encodeURIComponent(ids.card)}`);
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeTruthy();
    await screen.findByRole("listbox", { name: "Graph nodes" });
    expect(screen.queryByTestId("stale-marker")).toBeNull();

    // A save in the editor, then the tab gets focus back: that request carries the stale count.
    mock.edit();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect((await screen.findByTestId("stale-marker")).textContent).toBe("Out of date (1 file)");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByTestId("stale-marker")).toBeNull());
    expect(mock.refreshCalls()).toBe(1);
    const row = await screen.findByRole("option", { name: /refreshedHelper/ });
    expect(row.getAttribute("data-fresh")).toBe("true");
    // The view, the meta counts and the inspector were fetched again; the selection stayed.
    const views = mock.calls.filter((c) => c.startsWith("/api/view/project-map"));
    expect(views.length).toBeGreaterThanOrEqual(2);
    expect(
      mock.calls.filter((c) => c === `/api/node/${encodeURIComponent(ids.card)}`).length,
    ).toBeGreaterThanOrEqual(2);
    expect(window.location.hash).toContain(encodeURIComponent(ids.card));
    expect(screen.getByRole("button", { name: "Refresh" }).getAttribute("title")).toMatch(
      /1 files, 1 functions/,
    );
  });

  it("drops the selection when its node is gone after a refresh", async () => {
    installMockFetch((url) => {
      if (url.pathname === "/api/refresh")
        return {
          status: 200,
          body: {
            changed: { files: 1, functions: 1 },
            ms: 1,
            healed: false,
            files: [ids.buttonFile],
            functions: { added: [], changed: [], removed: [ids.button] },
          },
        };
      if (url.pathname === `/api/node/${encodeURIComponent(ids.button)}` && refreshStore.get().generation > 0)
        return { status: 404, body: { error: "Unknown node" } };
      return undefined;
    });
    renderApp(`#/project-map?level=symbols&sel=${encodeURIComponent(ids.button)}`);
    await screen.findByRole("complementary", { name: "Inspector" });
    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(window.location.hash).not.toContain("sel="));
  });
});

describe("freshIds", () => {
  it("highlights added and changed functions and the changed files, not the removed ones", () => {
    const set = freshIds({
      changed: { files: 2, functions: 3 },
      ms: 0,
      healed: false,
      files: ["file:a.ts", "file:b.ts"],
      functions: { added: ["sym:a.ts#x"], changed: ["sym:b.ts#y"], removed: ["sym:b.ts#z"] },
    });
    expect([...set].sort()).toEqual(["file:a.ts", "file:b.ts", "sym:a.ts#x", "sym:b.ts#y"]);
  });
});

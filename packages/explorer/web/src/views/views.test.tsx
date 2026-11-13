// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ids } from "../../mock/fixture.ts";
import type { GraphNode } from "../api.ts";
import "../canvases.ts";
import { orderNodes } from "../components/ListCanvas.tsx";
import { installMockFetch, renderApp } from "../testUtils.tsx";
import { breadcrumbTrail } from "./ProjectMapPanel.tsx";

/** The `/api/view/<id>` requests made so far, with their query parsed. */
function viewCalls(calls: string[], view: string) {
  return calls
    .filter((c) => c.startsWith(`/api/view/${view}`))
    .map((c) => new URL(c, "http://x").searchParams);
}

/** The latest request that carries filters (the panel's own workspace-list request never does). */
const lastMain = (calls: string[], view: string) =>
  viewCalls(calls, view)
    .filter((p) => !(p.get("level") === "workspaces" && !p.get("filters") && !p.get("focus")))
    .at(-1);

const hashParams = () => new URLSearchParams(window.location.hash.split("?")[1] ?? "");
const filtersOf = (p: URLSearchParams | undefined) =>
  JSON.parse(p?.get("filters") ?? "{}") as Record<string, string>;

describe("view params from the hash reach /api/view", () => {
  it("forwards level and filters to the project map", async () => {
    const { calls } = installMockFetch();
    renderApp(
      "#/project-map?level=workspaces&hideTests=false&workspaces=ws%3A%40acme%2Fui%7Cws%3A%40acme%2Futils",
    );
    await screen.findByRole("option", { name: /@acme\/ui/ });
    await waitFor(() => expect(lastMain(calls, "project-map")?.get("level")).toBe("workspaces"));
    expect(filtersOf(lastMain(calls, "project-map"))).toEqual({
      hideTests: "false",
      workspaces: "ws:@acme/ui|ws:@acme/utils",
    });
    // The mock honours them like the real server: only the two chosen workspaces come back.
    expect(screen.queryByRole("option", { name: /@acme\/web/ })).toBeNull();
    expect(screen.getByRole("option", { name: /@acme\/utils/ })).toBeTruthy();
  });

  it("forwards focus, and hops plus filters to the ego view", async () => {
    const { calls } = installMockFetch();
    renderApp(`#/ego?focus=${encodeURIComponent(ids.postList)}&hops=1&highConfidence=true&edgeKinds=calls`);
    await screen.findByRole("option", { name: /PostList/ });
    const p = lastMain(calls, "ego");
    expect(p?.get("focus")).toBe(ids.postList);
    expect(p?.get("hops")).toBe("1");
    expect(filtersOf(p)).toEqual({ highConfidence: "true", edgeKinds: "calls" });
  });

  it("does not send the inspector selection to the server", async () => {
    const { calls } = installMockFetch();
    renderApp(`#/project-map?sel=${encodeURIComponent(ids.button)}`);
    await screen.findByRole("complementary", { name: "Inspector" });
    const main = lastMain(calls, "project-map");
    expect(main?.has("sel")).toBe(false);
    expect(main?.has("focus")).toBe(false);
  });
});

describe("project map filter panel", () => {
  it("marks the current level and changes it from the segmented switch", async () => {
    installMockFetch();
    renderApp("#/project-map");
    const group = await screen.findByRole("radiogroup", { name: "Detail level" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Workspaces", "Folders", "Files", "Functions"]);
    expect(within(group).getByRole("radio", { name: "Files" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(within(group).getByRole("radio", { name: "Workspaces" }));
    await waitFor(() => expect(hashParams().get("level")).toBe("workspaces"));
    expect(within(group).getByRole("radio", { name: "Workspaces" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    // Workspaces only: no files in the list any more.
    await waitFor(() => expect(screen.queryByRole("option", { name: /button\.tsx/ })).toBeNull());

    fireEvent.click(within(group).getByRole("radio", { name: "Functions" }));
    await waitFor(() => expect(hashParams().get("level")).toBe("symbols"));
    expect(await screen.findByRole("option", { name: /Button/ })).toBeTruthy();
  });

  it("lists every workspace with a colour dot and file count, and keeps unticked ones in the list", async () => {
    installMockFetch();
    renderApp("#/project-map");
    const section = await screen.findByRole("region", { name: "Workspaces" });
    // Rows show the short name (the server strips the shared `@acme/` scope) and the workspace's own counts.
    const web = await within(section).findByRole("checkbox", { name: /^web/ });
    expect((web as HTMLInputElement).checked).toBe(true);
    expect(within(section).getAllByRole("checkbox")).toHaveLength(5);
    expect(section.querySelectorAll(".kind-dot")).toHaveLength(5);
    expect(section.querySelectorAll(".check-note")).toHaveLength(5);
    for (const note of section.querySelectorAll(".check-note"))
      expect(note.textContent).toMatch(/^\d+ functions? · \d+ files?$/);
    // The full name stays available as the tooltip.
    expect(web.closest("label")?.getAttribute("title")).toContain("@acme/web");

    fireEvent.click(web);
    await waitFor(() =>
      expect(hashParams().get("workspaces")).toBe("ws:@acme/api|ws:@acme/db|ws:@acme/ui|ws:@acme/utils"),
    );
    await waitFor(() => expect(screen.queryByRole("option", { name: /@acme\/web/ })).toBeNull());
    // Still listed, now unticked, so it can be switched back on.
    const again = within(section).getByRole("checkbox", { name: /^web/ }) as HTMLInputElement;
    expect(again.checked).toBe(false);
    fireEvent.click(within(section).getByRole("button", { name: "Show all workspaces" }));
    await waitFor(() => expect(hashParams().has("workspaces")).toBe(false));
  });

  it("writes kind checkboxes, 'Exported only', 'Hide tests' (on by default) and 'Show npm packages'", async () => {
    installMockFetch();
    // The kind colours matter only once functions are drawn, so the checkboxes appear at that level.
    renderApp("#/project-map?level=symbols");
    const hideTests = (await screen.findByRole("checkbox", { name: "Hide tests" })) as HTMLInputElement;
    expect(hideTests.checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Exported only" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "Show npm packages" }) as HTMLInputElement).checked).toBe(
      false,
    );

    fireEvent.click(hideTests);
    await waitFor(() => expect(hashParams().get("hideTests")).toBe("false"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Exported only" }));
    await waitFor(() => expect(hashParams().get("exportedOnly")).toBe("true"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show npm packages" }));
    await waitFor(() => expect(hashParams().get("showExternal")).toBe("true"));

    // Back to the defaults leaves no trace in the URL.
    fireEvent.click(screen.getByRole("checkbox", { name: "Hide tests" }));
    await waitFor(() => expect(hashParams().has("hideTests")).toBe(false));

    const hooks = screen.getByRole("checkbox", { name: "Hooks" }) as HTMLInputElement;
    expect(hooks.checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Classes" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(hooks);
    await waitFor(() => expect(hashParams().get("kinds")).toBe("function|method|component"));
  });

  it("'Hide tests' really hides test files and unticking shows them", async () => {
    installMockFetch();
    renderApp("#/project-map");
    await screen.findByRole("option", { name: /^button\.tsx/ });
    expect(screen.queryByRole("option", { name: /button\.test\.tsx/ })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Hide tests" }));
    expect(await screen.findByRole("option", { name: /button\.test\.tsx/ })).toBeTruthy();
  });
});

describe("going into a node", () => {
  it("double-click sets focus, shows a breadcrumb with links up, and 'Show whole repo' resets", async () => {
    const { calls } = installMockFetch();
    renderApp("#/project-map");
    fireEvent.doubleClick(await screen.findByRole("option", { name: /@acme\/ui/ }));
    await waitFor(() => expect(hashParams().get("focus")).toBe(ids.uiWs));
    await waitFor(() => expect(lastMain(calls, "project-map")?.get("focus")).toBe(ids.uiWs));

    const trail = await screen.findByRole("navigation", { name: "Breadcrumb" });
    expect(within(trail).getByText("@acme/ui").getAttribute("aria-current")).toBe("location");
    expect(screen.getByText(/Showing what is directly inside @acme\/ui/)).toBeTruthy();
    // Only that workspace's subtree: no other workspace is a row.
    expect(screen.queryByRole("option", { name: /@acme\/web/ })).toBeNull();

    // Go one level deeper into the folder.
    fireEvent.doubleClick(await screen.findByRole("option", { name: /^src/ }));
    await waitFor(() => expect(hashParams().get("focus")).toBe(ids.uiSrcDir));
    const deeper = await screen.findByRole("navigation", { name: "Breadcrumb" });
    await waitFor(() =>
      expect(within(deeper).getByText("src").getAttribute("aria-current")).toBe("location"),
    );

    // A link back up.
    fireEvent.click(within(deeper).getByRole("button", { name: "@acme/ui" }));
    await waitFor(() => expect(hashParams().get("focus")).toBe(ids.uiWs));

    fireEvent.click(screen.getByRole("button", { name: "Show whole repo" }));
    await waitFor(() => expect(hashParams().has("focus")).toBe(false));
    expect(await screen.findByRole("option", { name: /@acme\/web/ })).toBeTruthy();
  });

  it("double-click on a function selects it instead of focusing it", async () => {
    installMockFetch();
    renderApp("#/project-map?level=symbols");
    fireEvent.doubleClick(await screen.findByRole("option", { name: /^Button/ }));
    await waitFor(() => expect(hashParams().get("sel")).toBe(ids.button));
    expect(hashParams().has("focus")).toBe(false);
  });

  it("breadcrumbTrail walks parent links from the focus up", () => {
    const nodes: GraphNode[] = [
      { id: "ws:a", kind: "workspace", label: "a", size: 1 },
      { id: "dir:a/src", kind: "dir", label: "src", size: 1, parent: "ws:a" },
      { id: "file:a/src/x.ts", kind: "file", label: "x.ts", size: 1, parent: "dir:a/src" },
    ];
    expect(breadcrumbTrail(nodes, "file:a/src/x.ts").map((n) => n.label)).toEqual(["a", "src", "x.ts"]);
    expect(breadcrumbTrail(nodes, null)).toEqual([]);
    expect(breadcrumbTrail(nodes, "missing")).toEqual([]);
  });
});

describe("placeholder list order", () => {
  it("puts children under their parent and ego callers before callees", () => {
    const tree: GraphNode[] = [
      { id: "dir:a", kind: "dir", label: "src", size: 1, parent: "ws:a" },
      { id: "ws:b", kind: "workspace", label: "b", size: 1 },
      { id: "ws:a", kind: "workspace", label: "a", size: 1 },
    ];
    expect(orderNodes(tree).map((n) => n.id)).toEqual(["ws:a", "dir:a", "ws:b"]);
    const ego: GraphNode[] = [
      { id: "o", kind: "function", label: "o", size: 1, side: "out", hop: 1 },
      { id: "i2", kind: "function", label: "i2", size: 1, side: "in", hop: 2 },
      { id: "i1", kind: "function", label: "i1", size: 1, side: "in", hop: 1 },
      { id: "f", kind: "function", label: "f", size: 1, side: "focus", hop: 0 },
    ];
    expect(orderNodes(ego).map((n) => n.id)).toEqual(["f", "i1", "i2", "o"]);
  });
});

describe("ego view", () => {
  it("shows an empty state, sends no request, and search + Enter sets the focus", async () => {
    const { calls } = installMockFetch();
    renderApp("#/ego");
    expect(await screen.findByText("Pick a function to see its callers and callees")).toBeTruthy();
    expect(screen.getByText(/Search for a different function|Nothing chosen yet/i)).toBeTruthy();
    expect(viewCalls(calls, "ego")).toHaveLength(0);

    const box = screen.getByRole("combobox", { name: "Search symbols" });
    fireEvent.change(box, { target: { value: "Butt" } });
    await screen.findByRole("option", { name: /Button/ });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(hashParams().get("focus")).toBe(ids.button));
    // Callers (left) are listed with how far away they are, and the centre is marked.
    expect(await screen.findByRole("option", { name: /PostList.*caller, 1 away/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Button.*centre/ })).toBeTruthy();
    expect(screen.queryByText("Pick a function to see its callers and callees")).toBeNull();
    expect(lastMain(calls, "ego")?.get("focus")).toBe(ids.button);
  });

  it("the empty-state button moves focus to the search box", async () => {
    installMockFetch();
    renderApp("#/ego");
    fireEvent.click(await screen.findByRole("button", { name: "Search for a function" }));
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Search symbols" }));
  });

  it("slider, connection types and 'High confidence only' change the request", async () => {
    const { calls } = installMockFetch();
    renderApp(`#/ego?focus=${encodeURIComponent(ids.postList)}`);
    const slider = (await screen.findByRole("slider")) as HTMLInputElement;
    expect(slider.min).toBe("1");
    expect(slider.max).toBe("4");
    expect(slider.value).toBe("2");
    await screen.findByRole("option", { name: /useDebounce/ });

    fireEvent.change(slider, { target: { value: "3" } });
    await waitFor(() => expect(hashParams().get("hops")).toBe("3"));
    await waitFor(() => expect(lastMain(calls, "ego")?.get("hops")).toBe("3"));
    fireEvent.change(slider, { target: { value: "2" } });
    await waitFor(() => expect(hashParams().has("hops")).toBe(false));

    // Defaults: calls, renders and hooks on; imports off.
    expect((screen.getByRole("checkbox", { name: "Calls" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Imports" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Renders" }));
    await waitFor(() => expect(hashParams().get("edgeKinds")).toBe("calls|uses_hook"));
    await waitFor(() => expect(screen.queryByRole("option", { name: /Button/ })).toBeNull());

    fireEvent.click(screen.getByRole("checkbox", { name: "High confidence only" }));
    await waitFor(() => expect(hashParams().get("highConfidence")).toBe("true"));
    // The low-confidence hook link is gone.
    await waitFor(() => expect(screen.queryByRole("option", { name: /useDebounce/ })).toBeNull());
    expect(filtersOf(lastMain(calls, "ego"))).toEqual({
      edgeKinds: "calls|uses_hook",
      highConfidence: "true",
    });
  });

  it("never lets the last connection type be switched off", async () => {
    installMockFetch();
    renderApp(`#/ego?focus=${encodeURIComponent(ids.postList)}&edgeKinds=calls`);
    const calls = (await screen.findByRole("checkbox", { name: "Calls" })) as HTMLInputElement;
    expect(calls.disabled).toBe(true);
  });

  it("says so when nothing is connected", async () => {
    installMockFetch();
    renderApp(`#/ego?focus=${encodeURIComponent(ids.listPosts)}&edgeKinds=renders`);
    expect(await screen.findByText(/Nothing is connected within 2 steps/)).toBeTruthy();
  });

  it("shows the server's error for a bad focus, with a way out", async () => {
    installMockFetch();
    renderApp("#/ego?focus=sym%3Anope");
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Unknown focus: sym:nope")).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: "Reset this view" }));
    expect(await screen.findByText("Pick a function to see its callers and callees")).toBeTruthy();
  });

  it("double-click re-centres on a caller", async () => {
    installMockFetch();
    renderApp(`#/ego?focus=${encodeURIComponent(ids.button)}`);
    fireEvent.doubleClick(await screen.findByRole("option", { name: /PostList/ }));
    await waitFor(() => expect(hashParams().get("focus")).toBe(ids.postList));
  });
});

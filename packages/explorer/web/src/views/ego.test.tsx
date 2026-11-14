// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { egoHub, hubFocus } from "../../mock/hubEgo.ts";
import type { GraphNode } from "../api.ts";
import "../canvases.ts";
import { installMockFetch, renderApp } from "../testUtils.tsx";
import {
  describeSide,
  EGO_MAX_NODES,
  expandedIds,
  summarizeEgo,
  toggleExpanded,
  withExpanded,
  workspaceShortNames,
} from "./egoGroups.ts";

const hub = `#/ego?focus=${encodeURIComponent(hubFocus)}&scenario=hub`;
const hashParams = () => new URLSearchParams(window.location.hash.split("?")[1] ?? "");

describe("ego expand filter helpers", () => {
  it("reads, toggles and clears the `expand` list", () => {
    expect(expandedIds({})).toEqual([]);
    const one = toggleExpanded({ hideTests: "false" }, "group:in:1:ws:a");
    expect(one).toEqual({ hideTests: "false", expand: "group:in:1:ws:a" });
    const two = toggleExpanded(one, "group:in:1:ws:b");
    expect(expandedIds(two)).toEqual(["group:in:1:ws:a", "group:in:1:ws:b"]);
    expect(toggleExpanded(two, "group:in:1:ws:a")).toEqual({ hideTests: "false", expand: "group:in:1:ws:b" });
    expect(withExpanded(two, [])).toEqual({ hideTests: "false" });
    expect(withExpanded({}, ["x", "x"])).toEqual({ expand: "x" });
  });
});

describe("ego summary", () => {
  const fn = (id: string, side: "in" | "out", ws: string, path: string): GraphNode => ({
    id,
    kind: "function",
    label: id,
    size: 1,
    path,
    workspace: ws,
    side,
    hop: 1,
  });
  const group = (id: string, n: number, expanded = false): GraphNode => ({
    id,
    kind: "group",
    label: id,
    size: n,
    side: "in",
    hop: 1,
    workspace: "ws:a",
    stats: { members: n, files: 2 },
    members: [
      { id: "m1", label: "m1", path: "a/x.ts" },
      { id: "m2", label: "m2", path: "a/y.ts" },
    ],
    ...(expanded ? { expanded: true } : {}),
  });

  it("counts callers by group size and reads in plain words", () => {
    const nodes: GraphNode[] = [
      { id: "f", kind: "function", label: "f", size: 1, side: "focus", hop: 0 },
      group("g1", 100),
      group("g2", 50),
      fn("c", "out", "ws:b", "b/c.ts"),
    ];
    const s = summarizeEgo(nodes);
    expect(s.callers.count).toBe(150);
    expect(describeSide(s.callers, "caller", "callers")).toBe("150 callers · 2 files");
    expect(describeSide(s.callees, "callee", "callees")).toBe("1 callee");
    expect(s.groups.map((g) => g.id)).toEqual(["g1", "g2"]);
  });

  it("an expanded group counts through its members, and 'all expanded' knows the node cap", () => {
    const nodes: GraphNode[] = [
      { id: "f", kind: "function", label: "f", size: 1, side: "focus", hop: 0 },
      group("g1", 300),
      group("g2", 200, true),
    ];
    const s = summarizeEgo(nodes);
    expect(s.callers.count).toBe(300);
    expect(s.nodesIfAllExpanded).toBe(3 + 13); // an expansion shows one page (14 rows) at most
    expect(s.nodesIfAllExpanded).toBeLessThanOrEqual(EGO_MAX_NODES);
    const many = Array.from({ length: 40 }, (_, i) => group(`h${i}`, 300));
    expect(summarizeEgo([...nodes, ...many]).nodesIfAllExpanded).toBeGreaterThan(EGO_MAX_NODES);
  });

  it("drops a shared npm scope from workspace names", () => {
    const names = workspaceShortNames(["ws:@acme/ui", "ws:@acme/web", "ws:other"]);
    expect([...names.values()]).toEqual(["ui", "web", "other"]);
  });
});

describe("ego panel on the hub scenario", () => {
  const firstExpand = (groups: HTMLElement): HTMLElement =>
    within(groups).getAllByRole("button", { name: /^Expand (?!all)/ })[0] as HTMLElement;

  it("summarises the sides in plain words and lists the groups with their full labels", async () => {
    installMockFetch();
    renderApp(hub);
    expect(await screen.findByText(/^221 callers in 3 workspaces · \d+ files$/)).toBeTruthy();
    expect(screen.getByText("1 callee")).toBeTruthy();
    const groups = screen.getByRole("region", { name: "Groups" });
    expect(within(groups).getAllByRole("button", { name: /^Expand (?!all)/ }).length).toBeGreaterThanOrEqual(
      8,
    );
    // A row says what it is, in words, and is not cut short.
    expect(within(groups).getAllByText(/ — \d+ callers in \d+ files$/).length).toBeGreaterThan(0);
    expect(groups.textContent).not.toContain("…");
    expect((within(groups).getByRole("button", { name: "Collapse all" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // Colour key: one row per workspace, short names, the workspace with the most callers first.
    const key = screen.getByRole("region", { name: "Workspace colours" });
    const names = within(key)
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    expect(names).toHaveLength(4); // the three caller workspaces and the callee's
    expect(names[0]).toMatch(/^web\d+$/);
    expect(key.textContent).toContain("marketing");
    expect(key.textContent).not.toContain("@acme");
  });

  it("expanding a group puts it in the hash route; collapse all clears it", async () => {
    const { calls } = installMockFetch();
    renderApp(hub);
    const groups = await screen.findByRole("region", { name: "Groups" });
    const toggle = firstExpand(groups);
    const label = (toggle.getAttribute("aria-label") ?? "").replace(/^Expand /, "");
    fireEvent.click(toggle);
    await waitFor(() => expect(hashParams().get("expand")).toMatch(/^group:in:1:/));
    const id = hashParams().get("expand") as string;
    // The server (here: the mock) is asked for it, and the panel now offers to collapse it.
    await waitFor(() => {
      const last = calls.filter((c) => c.startsWith("/api/view/ego")).at(-1) ?? "";
      expect(JSON.parse(new URL(last, "http://x").searchParams.get("filters") ?? "{}")).toMatchObject({
        expand: id,
      });
    });
    expect(await screen.findByRole("button", { name: `Collapse ${label}` })).toBeTruthy();
    expect(screen.getByText(/^221 callers in 3 workspaces/)).toBeTruthy();

    // A second group, then Collapse all.
    fireEvent.click(firstExpand(groups));
    await waitFor(() => expect(hashParams().get("expand")?.split("|")).toHaveLength(2));
    fireEvent.click(within(groups).getByRole("button", { name: "Collapse all" }));
    await waitFor(() => expect(hashParams().has("expand")).toBe(false));
  });

  it("Expand all opens every group on the side", async () => {
    installMockFetch();
    renderApp(hub);
    const groups = await screen.findByRole("region", { name: "Groups" });
    const expandAll = within(groups).getByRole("button", { name: "Expand all" }) as HTMLButtonElement;
    await waitFor(() => expect(expandAll.disabled).toBe(false));
    const before = within(groups).getAllByRole("button", { name: /^Expand (?!all)/ }).length;
    fireEvent.click(expandAll);
    await waitFor(() => expect(hashParams().get("expand")?.split("|").length).toBe(before));
    expect(await screen.findByText(/^221 callers in 3 workspaces/)).toBeTruthy();
    expect(
      within(groups).getAllByRole("button", { name: /^Collapse (?!all)/ }).length,
    ).toBeGreaterThanOrEqual(before);
  });

  it("a group's inspector lists its members; picking one opens the group and selects it", async () => {
    installMockFetch();
    const rows = egoHub([], "hub", 19).nodes.filter((n) => n.kind === "group");
    const target = rows.find(
      (n) => (n.members?.length ?? 0) >= 4 && (n.members?.length ?? 0) < 8,
    ) as GraphNode;
    expect(target).toBeTruthy();
    renderApp(`${hub}&sel=${encodeURIComponent(target.id)}`);
    const inspector = await screen.findByRole("complementary", { name: "Inspector" });
    const members = await within(inspector).findByRole("region", { name: "Group members" });
    expect(within(members).getAllByRole("listitem")).toHaveLength(target.members?.length ?? 0);
    const first = within(members).getAllByRole("button")[0] as HTMLElement;
    fireEvent.click(first);
    await waitFor(() => expect(hashParams().get("expand")).toBe(target.id));
    await waitFor(() => expect(hashParams().get("sel")).toBe(target.members?.[0]?.id));
  });
});

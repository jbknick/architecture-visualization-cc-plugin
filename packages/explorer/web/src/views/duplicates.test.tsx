// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { handleMockApi } from "../../mock/fixture.ts";
import type { DupCluster, DupMember } from "../api.ts";
import "../canvases.ts";
import { installMockFetch, renderApp } from "../testUtils.tsx";
import {
  alignLines,
  copiesLine,
  nameLine,
  overviewLine,
  pairsToDismiss,
  percent,
  roundLines,
  skippedBanner,
  splitLabel,
} from "./dupModel.ts";

const member = (over: Partial<DupMember>): DupMember => ({
  id: "sym:a.ts#f",
  name: "f",
  kind: "function",
  path: "a.ts",
  line: 1,
  endLine: 3,
  loc: 3,
  workspaceId: "ws:@acme/utils",
  exported: true,
  fanIn: 1,
  tier: "near",
  score: 0.9,
  keep: false,
  ...over,
});

describe("dupModel", () => {
  it("words: counts, overview line, names", () => {
    expect(copiesLine({ size: 3, loc: 84 })).toBe("3 copies · 84 lines");
    expect(copiesLine({ size: 2, loc: 1 })).toBe("2 copies · 1 line");
    expect(overviewLine({ clusters: 22, functions: 83, duplicateLines: 1923 })).toBe(
      "22 groups · 83 functions · about 1,900 duplicated lines",
    );
    expect(roundLines(42)).toBe(42);
    expect(roundLines(1949)).toBe(1900);
    const c = { members: ["a", "b", "b", "c", "d"].map((name) => member({ name })) } as DupCluster;
    expect(nameLine(c)).toBe("a · b · c +1 more");
  });

  it("only identical code reads 100%", () => {
    expect(percent(1, "exact")).toBe("100%");
    expect(percent(1, "near")).toBe("99%");
    expect(percent(0.874, "near")).toBe("87%");
    expect(percent(null, "near")).toBeNull();
  });

  it("labels workspace splits", () => {
    const byId = new Map([
      ["ws:a", { id: "ws:a", name: "@x/a", shortLabel: "a", kind: "package" }],
      ["ws:b", { id: "ws:b", name: "@x/b", shortLabel: "b", kind: "app" }],
    ]);
    expect(splitLabel({ workspaces: ["ws:a"], clusters: 1, functions: 2 }, byId)).toBe("a only");
    expect(splitLabel({ workspaces: ["ws:a", "ws:b"], clusters: 1, functions: 2 }, byId)).toBe("a ↔ b");
  });

  it("banner prefers the vector message", () => {
    expect(skippedBanner([])).toBeNull();
    expect(
      skippedBanner([{ tier: "code_vector", reason: "not_embedded", message: "Run gantry embed." }]),
    ).toBe("Only identical and nearly identical code was checked. Run gantry embed.");
  });

  it("dismisses the direct pair, or every link of a member that only hangs on another copy", () => {
    const cluster = {
      keep: "k",
      links: [
        { a: "k", b: "m1", tier: "near" },
        { a: "m1", b: "m2", tier: "near" },
      ],
    } as DupCluster;
    expect(pairsToDismiss(cluster, member({ id: "m1" }))).toEqual([["k", "m1"]]);
    expect(pairsToDismiss(cluster, member({ id: "m2" }))).toEqual([["m1", "m2"]]);
  });

  it("aligns equal lines, pairs changed lines and leaves gaps for extra ones", () => {
    const rows = alignLines(["a", "b", "c", "d"], ["a", "B", "c", "x", "d"]);
    expect(rows).toEqual([
      { left: 0, right: 0, differs: false },
      { left: 1, right: 1, differs: true },
      { left: 2, right: 2, differs: false },
      { left: null, right: 3, differs: true },
      { left: 3, right: 4, differs: false },
    ]);
    // Indentation alone is not a difference.
    expect(alignLines(["  a"], ["a"])[0]?.differs).toBe(false);
    expect(alignLines([], [])).toEqual([]);
  });
});

const list = () => screen.getByRole("list", { name: "Duplicate groups, biggest first" });

describe("duplicates view", () => {
  it("is in the view switcher and shows the overview, the ranked list and the first group", async () => {
    installMockFetch();
    renderApp("#/duplicates");
    expect(await screen.findByRole("tab", { name: "Duplicates" })).toBeTruthy();
    const rows = await within(await screen.findByRole("list", { name: /Duplicate groups/ })).findAllByRole(
      "button",
    );
    expect(rows).toHaveLength(2);
    expect(screen.getByText(/2 groups · 4 functions · about 19 duplicated lines/)).toBeTruthy();
    // Plain words, never the engine's tier names.
    expect(rows[0]?.textContent).toMatch(/Nearly identical|Identical/);
    expect(document.body.textContent).not.toMatch(/code_vector|exact\b/);
    expect(within(list()).getByText("2 copies · 22 lines")).toBeTruthy();
    // The banner says what was not checked.
    expect(screen.getByRole("note").textContent).toContain("Run gantry embed to also find renamed copies.");
  });

  it("shows one card per copy with the keep candidate marked, and a side-by-side comparison", async () => {
    installMockFetch();
    renderApp("#/duplicates");
    await screen.findByRole("list", { name: /Duplicate groups/ });
    const slug = within(list())
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("slugify"));
    if (!slug) throw new Error("slugify group missing");
    fireEvent.click(slug);
    const cards = await screen.findByRole("list", { name: "Copies in this group" });
    const items = within(cards).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(cards).getAllByText("Keep this one")).toHaveLength(1);
    expect(within(cards).getByText(/In the shared package @acme\/utils/)).toBeTruthy();
    expect(within(cards).getByText("packages/utils/src/slug.ts:8")).toBeTruthy();
    expect(within(cards).getByText(/100% the same as the one to keep/)).toBeTruthy();
    expect(within(cards).getAllByRole("button", { name: "Show callers" })).toHaveLength(2);
    expect(within(cards).getAllByRole("button", { name: "Open in project map" })).toHaveLength(2);
    expect(within(cards).getAllByRole("button", { name: "Not a duplicate" })).toHaveLength(1);
    const compare = await screen.findByRole("region", { name: /Compare slugify with slugify/ });
    await within(compare).findByText("no differing lines");
  });

  it("tints the lines that differ in the near pair", async () => {
    installMockFetch();
    renderApp("#/duplicates");
    const date = (
      await within(await screen.findByRole("list", { name: /Duplicate groups/ })).findAllByRole("button")
    ).find((b) => b.textContent?.includes("formatRelativeDate"));
    if (!date) throw new Error("date group missing");
    fireEvent.click(date);
    const compare = await screen.findByRole("region", {
      name: /Compare parseTimestamp with formatRelativeDate/,
    });
    await waitFor(() => expect(compare.querySelectorAll('[data-diff="true"]').length).toBeGreaterThan(0));
    expect(compare.querySelectorAll('[data-diff="false"]').length).toBeGreaterThan(0);
  });

  it("renders source text as text, never as HTML", async () => {
    installMockFetch((url) => {
      if (url.pathname !== "/api/source") return undefined;
      const start = Number(url.searchParams.get("start") ?? 1);
      const lines = [
        "export function f() {",
        '  return "<img src=x onerror=alert(1)>"; // <script>boom()</script>',
        "}",
      ];
      return {
        status: 200,
        body: { path: url.searchParams.get("path"), start, end: start + 2, total: 3, lines },
      };
    });
    renderApp("#/duplicates");
    const compare = await screen.findByRole("region", { name: /Compare/ });
    await waitFor(() => expect(compare.textContent).toContain("<img src=x onerror=alert(1)>"));
    expect(compare.querySelector("img")).toBeNull();
    expect(compare.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  it("copies path:line on click", async () => {
    installMockFetch();
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void written.push(t) },
    });
    renderApp("#/duplicates");
    const cards = await screen.findByRole("list", { name: "Copies in this group" });
    fireEvent.click(within(cards).getAllByTitle("Copy path and line")[0] as HTMLElement);
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toMatch(/^packages\/utils\/src\/\w+\.ts:\d+$/);
  });

  it("dismisses a pair with a reason and the group disappears", async () => {
    const { calls } = installMockFetch();
    renderApp("#/duplicates");
    const cards = await screen.findByRole("list", { name: "Copies in this group" });
    fireEvent.click(within(cards).getByRole("button", { name: "Not a duplicate" }));
    fireEvent.change(screen.getByPlaceholderText(/same shape/), { target: { value: "different rule" } });
    fireEvent.click(screen.getByRole("button", { name: "Hide this pair" }));
    await waitFor(() => expect(calls.some((c) => c.startsWith("PUT /api/dismiss"))).toBe(true));
    const put = calls.find((c) => c.startsWith("PUT /api/dismiss")) ?? "";
    expect(JSON.parse(put.slice("PUT /api/dismiss ".length))).toMatchObject({ reason: "different rule" });
    await waitFor(() => expect(within(list()).getAllByRole("button")).toHaveLength(1));
    expect(screen.getByText(/is no longer listed as a duplicate/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
  });

  it("explains an empty result", async () => {
    installMockFetch((url) => {
      if (url.pathname !== "/api/view/duplicates") return undefined;
      const real = handleMockApi(url);
      const body = real?.body as Record<string, unknown>;
      return {
        status: 200,
        body: {
          ...body,
          clusters: [],
          nodes: [],
          splits: [],
          skipped: [],
          summary: { clusters: 0, functions: 0, duplicateLines: 0, crossWorkspace: 0 },
        },
      };
    });
    renderApp("#/duplicates");
    expect(await screen.findByText("No duplicates found")).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("sends the filter panel's choices to the server", async () => {
    const { calls } = installMockFetch();
    renderApp("#/duplicates");
    await screen.findByRole("list", { name: /Duplicate groups/ });
    fireEvent.click(screen.getByRole("checkbox", { name: "Nearly identical" }));
    await waitFor(() =>
      expect(window.location.hash).toContain(`tiers=${encodeURIComponent("exact|code_vector|semantic")}`),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.includes("tiers") && c.startsWith("/api/view/duplicates"))).toBe(true),
    );
    const last = calls.filter((c) => c.startsWith("/api/view/duplicates")).at(-1) ?? "";
    expect(JSON.parse(new URL(last, "http://x").searchParams.get("filters") ?? "{}")).toEqual({
      tiers: "exact|code_vector|semantic",
    });
  });
});

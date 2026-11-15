// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { handleMockApi } from "../../mock/fixture.ts";
import type { ReviewConsumer, ReviewData, ReviewLayer, ViewData } from "../api.ts";
import "../canvases.ts";
import { ringEdges, ringNodes } from "../../mock/review.ts";
import { computeLayout } from "../canvas/layout.ts";
import { buildScene, layoutInputFor } from "../canvas/scene.ts";
import { installMockFetch, renderApp } from "../testUtils.tsx";
import {
  focusedChange,
  groupByFile,
  layerFocus,
  MARK_COLOURS,
  MARK_KINDS,
  markKindOf,
  paintLayer,
  placedId,
  RINGS_CAPTION,
  ringFocus,
  ringGroups,
  ringPath,
  ringTitle,
  shortName,
} from "./reviewModel.ts";

const BUTTON = "sym:packages/ui/src/button.tsx#Button";
const BUTTON_FILE = "file:packages/ui/src/button.tsx";
const CARD_FILE = "file:packages/ui/src/card.tsx";

function mockView(view: string, filters: Record<string, string>, level?: string): ViewData {
  const q = new URLSearchParams({ filters: JSON.stringify(filters), ...(level ? { level } : {}) });
  const res = handleMockApi(new URL(`http://127.0.0.1/api/view/${view}?${q}`));
  if (res?.status !== 200) throw new Error(`mock ${view}: ${JSON.stringify(res?.body)}`);
  return res.body as ViewData;
}

describe("reviewModel", () => {
  it("names, mark kinds and one colour per kind in both themes", () => {
    expect(shortName(BUTTON)).toBe("Button");
    expect(shortName("file:a/b/c.ts")).toBe("c.ts");
    expect(markKindOf({ kind: "modified", signatureChanged: true })).toBe("signature");
    expect(markKindOf({ kind: "modified", signatureChanged: false })).toBe("modified");
    expect(markKindOf({ kind: "renamed", signatureChanged: true })).toBe("moved");
    expect(markKindOf({ kind: "removed", signatureChanged: false })).toBe("removed");
    for (const scheme of ["light", "dark"] as const) {
      const colours = MARK_KINDS.map((k) => MARK_COLOURS[scheme][k]);
      expect(new Set(colours).size).toBe(MARK_KINDS.length);
    }
  });

  it("paintLayer: marks by index, ancestors lit, hop 2 only with far, lines and placed ids", () => {
    // ws -> dir -> {a.ts, b.ts, c.ts}; a.ts changed, b.ts hop 1, c.ts hop 2.
    const tree = {
      ids: ["ws:x", "dir:x", "file:a.ts", "file:b.ts", "file:c.ts", "ws:y"],
      parents: [-1, 0, 1, 1, 1, -1],
    };
    const layer: ReviewLayer = {
      marks: [
        { id: "file:a.ts", change: "signature", changes: 1 },
        { id: "file:b.ts", hop: 1 },
        { id: "file:c.ts", hop: 2 },
        { id: "file:gone.ts", change: "added" },
      ],
      links: [
        { id: "file:b.ts->file:a.ts", src: "file:b.ts", dst: "file:a.ts", change: "signature", weight: 2 },
        { id: "file:zz.ts->file:a.ts", src: "file:zz.ts", dst: "file:a.ts", change: "signature", weight: 1 },
      ],
      linksTotal: 2,
      placed: [["sym:a.ts#f", "file:a.ts"]],
      unplaced: [],
    };
    const p = paintLayer(tree, layer, false);
    expect(p.change).toEqual([null, null, "signature", null, null, null]);
    expect([...p.hop]).toEqual([0, 0, 0, 1, 0, 0]);
    expect([...p.lit]).toEqual([1, 1, 1, 1, 0, 0]);
    expect(p.links).toEqual([{ src: 3, dst: 2, change: "signature", weight: 2 }]);
    expect(p.placed.get("sym:a.ts#f")).toBe(2);
    const far = paintLayer(tree, layer, true);
    expect([...far.hop]).toEqual([0, 0, 0, 1, 2, 0]);
    expect([...far.lit]).toEqual([1, 1, 1, 1, 1, 0]);
    expect(placedId(layer, "sym:a.ts#f")).toBe("file:a.ts");
    expect(placedId(layer, "file:b.ts")).toBe("file:b.ts");
  });

  it("positions: the review map lays out exactly like the plain project map (same level and filters)", async () => {
    for (const level of ["workspaces", "dirs", "files", "symbols"]) {
      const plain = mockView("project-map", {}, level);
      const review = mockView("review", { range: "main...feature" }, level);
      expect(review.layoutHint).toBe("review");
      expect(review.nodes).toEqual(plain.nodes);
      expect(review.edges).toEqual(plain.edges);
      const lay = async (d: ViewData) =>
        (
          await computeLayout(
            layoutInputFor(buildScene(d.nodes, d.edges, "nested-elk"), "nested-elk", null, undefined, {
              w: 1100,
              h: 760,
            }),
          )
        ).positions;
      expect(await lay(review)).toEqual(await lay(plain));
    }
  });

  it("the mock layer on the map: Button's file coloured, Card's file tinted, a line Card -> Button", () => {
    const v = mockView("review", { range: "main...feature" }, "files");
    const layer = v.review?.layer as ReviewLayer;
    expect(layer.marks.find((m) => m.id === BUTTON_FILE)).toMatchObject({ change: "signature" });
    expect(layer.marks.find((m) => m.id === CARD_FILE)).toMatchObject({ hop: 1 });
    expect(layer.links.map((l) => l.id)).toContain(`${CARD_FILE}->${BUTTON_FILE}`);
    const scene = buildScene(v.nodes, v.edges, "nested-elk");
    const p = paintLayer(
      { ids: scene.tree.nodes.map((n) => n.id), parents: scene.tree.nodes.map((n) => n.parent) },
      layer,
      false,
    );
    const at = (id: string) => scene.tree.index.get(id) as number;
    expect(p.change[at(BUTTON_FILE)]).toBe("signature");
    expect(p.hop[at(CARD_FILE)]).toBe(1);
    expect(p.lit[at("file:packages/db/src/queries.ts")]).toBe(0);
    expect(p.placed.get(BUTTON)).toBe(at(BUTTON_FILE));
  });
});

describe("rings model", () => {
  it("names every ring in plain words", () => {
    expect([0, 1, 2, 3].map(ringTitle)).toEqual([
      "Changed in this range",
      "Call the changed code directly",
      "2 calls away",
      "3 calls away",
    ]);
  });

  it("groups each ring by file: a file's nodes sit side by side, groups in angle order", () => {
    const groups = ringGroups(ringNodes());
    const ring0 = groups.filter((g) => g.hop === 0).map((g) => g.label);
    expect(ring0).toEqual(["button.tsx", "date.ts", "slug.ts"]);
    for (const g of groups) expect(g.a1).toBeGreaterThanOrEqual(g.a0);
    // No other group starts inside a group's arc on the same ring.
    for (const g of groups)
      for (const o of groups) if (o !== g && o.hop === g.hop) expect(o.a0 > g.a1 || o.a1 < g.a0).toBe(true);
  });

  it("a node's path runs inward to the centre and outward to its callers", () => {
    const p = ringPath("sym:apps/web/src/components/PostList.tsx#PostList", ringEdges);
    expect([...p.nodes].sort()).toEqual(
      [
        "sym:apps/web/src/components/PostList.tsx#PostList",
        "sym:apps/web/src/hooks/useDebounce.ts#useDebounce",
        "sym:packages/utils/src/date.ts#formatTimeAgo",
      ].sort(),
    );
    expect(p.edges.size).toBe(2);
    expect(p.nodes.has("sym:packages/ui/src/button.tsx#Button")).toBe(false);
  });
});

describe("review view", () => {
  it("rings: caption, ring labels with counts, file groups, names on changed nodes, hover keeps the path", async () => {
    installMockFetch();
    renderApp("#/review?range=main...feature&mode=rings");
    const canvas = await screen.findByTestId("review-canvas");
    await waitFor(() => expect(canvas.getAttribute("data-mode")).toBe("rings"));
    expect(within(canvas).getByText(RINGS_CAPTION)).toBeTruthy();
    expect(within(canvas).getByText("Changed in this range (3)")).toBeTruthy();
    expect(within(canvas).getByText("Call the changed code directly (4)")).toBeTruthy();
    expect(within(canvas).getByText("2 calls away (1)")).toBeTruthy();
    expect(canvas.querySelectorAll(".rv-group-label").length).toBeGreaterThanOrEqual(3);
    const button = within(canvas).getByRole("button", { name: "Button, modified, signature changed" });
    expect(button.querySelector("circle")?.getAttribute("class")).toContain("rv-fill-signature");
    expect(within(canvas).getByText("formatTimeAgo")).toBeTruthy();
    expect(
      within(canvas).getByRole("button", { name: "Card, calls the changed code directly" }),
    ).toBeTruthy();
    // Edges point from the caller to the callee (an arrowhead at the callee).
    const e = canvas.querySelector(
      '[data-edge="sym:packages/ui/src/card.tsx#Card->sym:packages/ui/src/button.tsx#Button"]',
    );
    expect(e?.getAttribute("marker-end")).toContain("rv-arrow");
    // Hover: its path stays, the rest fades; the tooltip names the file and the hop.
    const post = within(canvas).getByRole("button", { name: "PostList, calls the changed code directly" });
    fireEvent.pointerEnter(post, { clientX: 10, clientY: 10 });
    expect(post.getAttribute("class")).not.toContain("rv-dim");
    expect(button.getAttribute("class")).toContain("rv-dim");
    expect(
      within(canvas)
        .getByRole("button", { name: /formatTimeAgo/ })
        .getAttribute("class"),
    ).not.toContain("rv-dim");
    const tip = within(canvas).getByRole("tooltip");
    expect(tip.textContent).toContain("apps/web/src/components/PostList.tsx");
    expect(tip.textContent).toContain("calls the changed code directly");
    expect(within(canvas).getByRole("complementary", { name: "Review legend" }).textContent).toContain(
      "Caller (fainter = farther)",
    );
  });

  it("asks for a range when none is given", async () => {
    installMockFetch();
    renderApp("#/review");
    expect(await screen.findByRole("heading", { name: "Pick a change to review" })).toBeTruthy();
  });

  it("renders on the 2D map with the legend; the left panel keeps risk, files, crossings and notes", async () => {
    installMockFetch();
    renderApp("#/review?range=main...feature");
    const canvas = await screen.findByTestId("review-canvas");
    await waitFor(() => expect(canvas.getAttribute("data-map")).toBe("2d"));
    const legend = within(canvas).getByRole("complementary", { name: "Review legend" });
    expect(within(legend).getByText("Signature changed")).toBeTruthy();
    expect(within(legend).getByText("Calls changed code")).toBeTruthy();
    expect(within(legend).getByText("Untouched")).toBeTruthy();

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
    // The description is plain text, inside the change block only.
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

  it("the range form, the 2D/3D toggle, the level and the hop 2-3 tint write the hash", async () => {
    installMockFetch();
    renderApp("#/review?range=main...feature");
    await screen.findByRole("region", { name: "Risk" });
    fireEvent.click(screen.getByRole("radio", { name: "Rings" }));
    await waitFor(() => expect(window.location.hash).toContain("mode=rings"));
    fireEvent.click(screen.getByRole("radio", { name: "On the map" }));
    await waitFor(() => expect(window.location.hash).not.toContain("mode=rings"));
    fireEvent.click(screen.getByRole("radio", { name: "Functions" }));
    await waitFor(() => expect(window.location.hash).toContain("level=symbols"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tint callers at hop 2 and 3" }));
    await waitFor(() => expect(window.location.hash).toContain("far=true"));
    fireEvent.click(screen.getByRole("radio", { name: "3D map" }));
    await waitFor(() => expect(window.location.hash).toContain("map=3d"));
    const canvas = await screen.findByTestId("review-canvas");
    await waitFor(() => expect(canvas.getAttribute("data-map")).toBe("3d"));

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

describe("consumers (#169)", () => {
  const consumer = (id: string, node: string): ReviewConsumer => ({
    id,
    name: shortName(id),
    kind: "function",
    path: id.slice(4, id.lastIndexOf("#")),
    line: 1,
    workspace: null,
    hop: 1,
    uses: ["calls"],
    crosses: [],
    node,
  });

  it("paintLayer with a focused change: only it, its direct consumers (strong) and potential ones (soft)", () => {
    const tree = {
      ids: ["ws:x", "file:a.ts", "file:b.ts", "file:c.ts", "file:d.ts"],
      parents: [-1, 0, 0, 0, 0],
    };
    const layer: ReviewLayer = {
      marks: [
        { id: "file:a.ts", change: "signature", changes: 1 },
        { id: "file:b.ts", hop: 1 },
        { id: "file:d.ts", change: "added", changes: 1 },
      ],
      links: [
        { id: "file:b.ts->file:a.ts", src: "file:b.ts", dst: "file:a.ts", change: "signature", weight: 1 },
      ],
      linksTotal: 1,
      placed: [["sym:a.ts#f", "file:a.ts"]],
      unplaced: [],
    };
    const p = paintLayer(tree, layer, false, {
      node: "file:a.ts",
      kind: "signature",
      direct: ["file:b.ts"],
      potential: [{ node: "file:c.ts", next: "file:b.ts" }],
    });
    // d.ts (another change) fades; c.ts gets the soft tint even without `far`
    expect(p.change).toEqual([null, "signature", null, null, null]);
    expect([...p.hop]).toEqual([0, 0, 1, 2, 0]);
    expect([...p.lit]).toEqual([1, 1, 1, 1, 0]);
    expect(p.links).toEqual([
      { src: 2, dst: 1, change: "signature", weight: 1 },
      { src: 3, dst: 2, change: "signature", weight: 1, soft: true },
    ]);
  });

  it("focusedChange keeps the change while one of its consumers is selected; groupByFile keeps the order", () => {
    const review = mockView("review", { range: "main...feature" }, "symbols").review as ReviewData;
    const card = "sym:packages/ui/src/card.tsx#Card";
    expect(focusedChange(review, BUTTON, null)).toBe(BUTTON);
    expect(focusedChange(review, BUTTON_FILE, BUTTON)).toBe(BUTTON_FILE);
    expect(focusedChange(review, card, BUTTON)).toBe(BUTTON);
    expect(focusedChange(review, card, null)).toBeNull();
    expect(focusedChange(review, null, BUTTON)).toBeNull();
    const groups = groupByFile([
      consumer("sym:a.ts#x", "a"),
      consumer("sym:a.ts#y", "a"),
      consumer("sym:b.ts#z", "b"),
    ]);
    expect(groups.map((g) => [g.path, g.items.length])).toEqual([
      ["a.ts", 2],
      ["b.ts", 1],
    ]);
    // every consumer is placed: clicking one zooms to its node
    const c = review.changes.find((x) => x.id === BUTTON)?.consumers;
    expect(c?.direct.map((d) => d.id)).toContain(card);
    expect(placedId(review.layer, card)).toBe(card);
    expect(layerFocus(review, BUTTON)?.direct).toContain(card);
  });

  it("ringFocus: direct edges strong, potential edges soft", () => {
    const review = mockView("review", { range: "main...feature", mode: "rings" }).review as ReviewData;
    const f = ringFocus(review, "sym:packages/utils/src/date.ts#formatTimeAgo", ringEdges);
    expect([...(f?.direct ?? [])]).toEqual(["sym:apps/web/src/components/PostList.tsx#PostList"]);
    expect([...(f?.potential ?? [])]).toEqual(["sym:apps/web/src/hooks/useDebounce.ts#useDebounce"]);
    expect([...(f?.strong ?? [])]).toEqual([
      "sym:apps/web/src/components/PostList.tsx#PostList->sym:packages/utils/src/date.ts#formatTimeAgo",
    ]);
    expect([...(f?.soft ?? [])]).toEqual([
      "sym:apps/web/src/hooks/useDebounce.ts#useDebounce->sym:apps/web/src/components/PostList.tsx#PostList",
    ]);
    expect(ringFocus(review, "sym:nope", ringEdges)).toBeNull();
  });

  it("a selected change expands to its two tiers in the panel and the inspector; a consumer click selects it", async () => {
    installMockFetch();
    renderApp("#/review?range=main...feature");
    const list = await screen.findByRole("region", { name: "Changed symbols" });
    fireEvent.click(within(list).getByRole("button", { name: /^Button/ }));
    const tiers = await within(list).findByRole("region", { name: "Consumers of Button" });
    expect(within(tiers).getByRole("heading", { name: "Directly affected (2)" })).toBeTruthy();
    expect(within(tiers).getByRole("heading", { name: "Potentially affected (1)" })).toBeTruthy();
    expect(tiers.textContent).toContain("packages/ui/src/card.tsx");
    expect(tiers.textContent).toContain("hop 2 via HomePage");
    const home = within(tiers).getByRole("button", { name: /^HomePage/ });
    expect(home.textContent).toContain("renders");
    expect(home.textContent).toContain("app uses a package");
    const inspector = await screen.findByRole("complementary", { name: "Inspector" });
    const usedBy = within(inspector).getByRole("region", { name: "Used by" });
    expect(within(usedBy).getByRole("heading", { name: "Used by (3)" })).toBeTruthy();
    expect(within(usedBy).getAllByRole("heading", { name: "Directly affected (2)" }).length).toBe(1);
    // clicking a consumer selects it; the change stays expanded (in focus)
    fireEvent.click(within(tiers).getByRole("button", { name: /^Card/ }));
    await waitFor(() =>
      expect(window.location.hash).toContain(
        `sel=${encodeURIComponent("sym:packages/ui/src/card.tsx#Card")}`,
      ),
    );
    expect(within(list).getByRole("region", { name: "Consumers of Button" })).toBeTruthy();
    // a changed file expands to the files that import it
    const files = screen.getByRole("region", { name: "Changed files" });
    fireEvent.click(within(files).getByRole("button", { name: /packages\/ui\/src\/button\.tsx/ }));
    const fileTiers = await within(files).findByRole("region", {
      name: "Consumers of packages/ui/src/button.tsx",
    });
    expect(within(fileTiers).getByRole("heading", { name: "Directly affected (2)" })).toBeTruthy();
  });

  it("rings: selecting a change marks its direct consumers strong and its potential ones soft", async () => {
    installMockFetch();
    const date = "sym:packages/utils/src/date.ts#formatTimeAgo";
    renderApp(`#/review?range=main...feature&mode=rings&sel=${encodeURIComponent(date)}`);
    const canvas = await screen.findByTestId("review-canvas");
    await waitFor(() =>
      expect(canvas.querySelector(".rv-rings")?.getAttribute("data-focus-change")).toBe(date),
    );
    const node = (id: string) => canvas.querySelector(`[data-id="${id}"]`);
    expect(node("sym:apps/web/src/components/PostList.tsx#PostList")?.getAttribute("data-tier")).toBe(
      "direct",
    );
    expect(node("sym:apps/web/src/hooks/useDebounce.ts#useDebounce")?.getAttribute("data-tier")).toBe(
      "potential",
    );
    expect(node(BUTTON)?.getAttribute("class")).toContain("rv-dim");
  });
});

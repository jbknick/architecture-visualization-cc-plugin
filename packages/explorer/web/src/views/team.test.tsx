// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ids } from "../../mock/fixture.ts";
import { mockTeamLayer } from "../../mock/team.ts";
import type { TeamLayerData } from "../api.ts";
import { contrastRatio } from "../canvas/style.ts";
import { refreshStore } from "../refresh.ts";
import { StoreProvider } from "../store.tsx";
import { installMockFetch } from "../testUtils.tsx";
import { workspaceColorAt } from "../workspacePalette.ts";
import { INITIAL_MIN_CONTRAST, initialColours, personColour } from "./personColours.ts";
import { TeamLayerPanel } from "./TeamLayerPanel.tsx";
import { TeamLayerRings } from "./TeamLayerRings.tsx";
import { TeamLayerToggle } from "./TeamLayerToggle.tsx";
import {
  ageWords,
  areaMarkers,
  changedRows,
  countText,
  currentAge,
  hubLabelFor,
  teamReach,
  teamReviewLayer,
  tierCounts,
  visibleSets,
} from "./teamModel.ts";
import { teamStore } from "./teamStore.ts";

const SCENARIO = "#/project-map?scenario=team";

function shell(ui: React.ReactNode) {
  return render(<StoreProvider>{ui}</StoreProvider>);
}

/** The mock's team scenario: three change sets by two people. */
async function teamData(): Promise<TeamLayerData> {
  return mockTeamLayer("team");
}

beforeEach(() => {
  teamStore.reset();
});
afterEach(() => {
  teamStore.reset();
});

describe("Team toggle", () => {
  it("renders nothing when there is no team cache", async () => {
    const { calls } = installMockFetch();
    window.location.hash = "#/project-map";
    shell(<TeamLayerToggle />);
    await waitFor(() => expect(calls.some((c) => c.startsWith("/api/team/layer"))).toBe(true));
    await waitFor(() => expect(teamStore.get().loaded).toBe(true));
    expect(screen.queryByRole("button", { name: /team/i })).toBeNull();
  });

  it("renders nothing when the server has no such route", async () => {
    installMockFetch((url) => (url.pathname === "/api/team/layer" ? { status: 404, body: {} } : undefined));
    window.location.hash = SCENARIO;
    shell(<TeamLayerToggle />);
    await waitFor(() => expect(teamStore.get().loaded).toBe(true));
    expect(screen.queryByTestId("team-toggle")).toBeNull();
  });

  it("is an off-by-default pressed-state button when a cache is there", async () => {
    installMockFetch();
    window.location.hash = SCENARIO;
    shell(<TeamLayerToggle />);
    const toggle = await screen.findByTestId("team-toggle");
    expect(toggle.textContent).toContain("Team");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(teamStore.get().on).toBe(true);
  });
});

describe("Team panel", () => {
  async function open(patch: (d: TeamLayerData) => TeamLayerData = (d) => d) {
    window.location.hash = SCENARIO;
    const data = patch(await teamData());
    // The store loads the way the toggle does, through fetch, with the patched answer.
    installMockFetch((url) => (url.pathname === "/api/team/layer" ? { status: 200, body: data } : undefined));
    await teamStore.load("team");
    act(() => {
      teamStore.setOn(true);
    });
    return shell(<TeamLayerPanel />);
  }

  it("lists every open change set with owner, PR number and counts, and the freshness line", async () => {
    await open();
    const entries = await screen.findAllByTestId("team-entry");
    expect(entries.map((e) => e.getAttribute("data-owner"))).toEqual(["tomas", "ines", "ines"]);
    const first = entries[0] as HTMLElement;
    expect(within(first).getByText("Cap listPosts to one page of rows")).toBeTruthy();
    expect(first.textContent).toContain("tomas");
    expect(first.textContent).toContain("#214");
    expect(first.textContent).toContain("2 changed");
    expect(first.textContent).toMatch(/\d+ direct/);
    expect(first.textContent).toMatch(/\d+ potential/);
    expect(first.textContent).toMatch(/\d+\+? reachable/);
    expect(screen.getByTestId("team-freshness").textContent).toContain("Team data pulled 12 min ago");
    expect(screen.getByRole("button", { name: /refresh/i })).toBeTruthy();
    expect(screen.getByText(/gantry team status --pull/)).toBeTruthy();
    expect(screen.getByText("3 open")).toBeTruthy();
  });

  it("marks data older than 24 hours as stale", async () => {
    await open((d) => ({ ...d, age_s: 30 * 3600 }));
    const line = await screen.findByTestId("team-freshness");
    expect(line.className).toContain("is-stale");
    expect(line.textContent).toContain("30 h ago");
  });

  it("says so when there are no open change sets", async () => {
    await open((d) => ({ ...d, change_sets: [], people: [] }));
    expect(await screen.findByText("No open pull requests in the team data")).toBeTruthy();
    expect(screen.queryAllByTestId("team-entry")).toHaveLength(0);
  });

  it("narrows the list with the person filter, and Show everyone clears it", async () => {
    await open();
    const group = await screen.findByRole("group", { name: "People" });
    const sam = within(group).getByRole("checkbox", { name: "tomas" });
    fireEvent.click(sam);
    await waitFor(() => expect(screen.getAllByTestId("team-entry")).toHaveLength(1));
    expect(screen.getByText("1 open")).toBeTruthy();
    expect(screen.getByTestId("team-entry").getAttribute("data-owner")).toBe("tomas");
    fireEvent.click(screen.getByRole("button", { name: "Show everyone" }));
    await waitFor(() => expect(screen.getAllByTestId("team-entry")).toHaveLength(3));
  });

  it("selects a change set: its rings, legend counts and changed nodes; a node opens the inspector", async () => {
    await open();
    const entry = (await screen.findAllByTestId("team-entry"))[0] as HTMLElement;
    fireEvent.click(within(entry).getByRole("button", { pressed: false }));
    expect(await screen.findByTestId("team-rings")).toBeTruthy();
    const nodes = await screen.findByTestId("team-nodes");
    const listPosts = within(nodes).getByRole("button", { name: /listPosts/ });
    fireEvent.click(listPosts);
    await waitFor(() => expect(window.location.hash).toContain(`sel=${encodeURIComponent(ids.listPosts)}`));
    // Pressing the entry again clears the selection.
    fireEvent.click(within(entry).getByRole("button", { pressed: true }));
    await waitFor(() => expect(screen.queryByTestId("team-rings")).toBeNull());
  });

  it("uses one definition of changed for the header, the hint and the rows when the nodes were cut", async () => {
    const [cs] = (await teamData()).change_sets;
    if (!cs) throw new Error("no change set");
    // 252 ids sent as 200: 100 symbols with their 100 files make 100 rows; the cut leaves the total at 252.
    const ids200 = Array.from({ length: 100 }, (_, i) => [
      `file:pnpm-turbo:packages/utils/src/g${i}.ts`,
      `sym:pnpm-turbo:packages/utils/src/g${i}.ts#f${i}`,
    ]).flat();
    const cut = { ...cs, nodes: ids200, nodes_total: 252 };
    const c = tierCounts(cut);
    expect(changedRows(cut)).toHaveLength(100);
    expect(c.changed).toBe(100);
    expect(c.changedFloor).toBe(true);
    await open((d) => ({ ...d, change_sets: [cut, ...d.change_sets.slice(1)] }));
    const entry = (await screen.findAllByTestId("team-entry"))[0] as HTMLElement;
    fireEvent.click(within(entry).getByRole("button", { pressed: false }));
    const heading = (await within(entry).findByText("Changed nodes")).closest("h4") as HTMLElement;
    expect(heading.textContent).toContain("100+");
    expect(within(entry).getByTestId("team-nodes").children).toHaveLength(100);
    expect(entry.textContent).toContain("Showing the first 100 changed nodes; more are in the team data.");
  });

  it("ages the freshness line on its own and turns stale past 24 hours without a Refresh", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      await open((d) => ({ ...d, age_s: 23 * 3600 + 10 }));
      const line = screen.getByTestId("team-freshness");
      expect(line.textContent).toContain("23 h ago");
      expect(line.className).not.toContain("is-stale");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(61 * 60 * 1000);
      });
      expect(screen.getByTestId("team-freshness").className).toContain("is-stale");
      expect(screen.getByTestId("team-freshness").textContent).toContain("24 h ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives focus back to the Team toggle when the panel is closed", async () => {
    window.location.hash = SCENARIO;
    installMockFetch();
    await teamStore.load("team");
    act(() => {
      teamStore.setOn(true);
    });
    shell(
      <>
        <TeamLayerToggle />
        <TeamLayerPanel />
      </>,
    );
    const close = await screen.findByRole("button", { name: "Close the Team layer" });
    close.focus();
    fireEvent.click(close);
    expect(teamStore.get().on).toBe(false);
    expect(document.activeElement).toBe(screen.getByTestId("team-toggle"));
  });

  it("renders titles and owner names as plain text", async () => {
    await open((d) => ({
      ...d,
      change_sets: d.change_sets.map((c, i) =>
        i === 0 ? { ...c, title: '<img src=x onerror="window.__team=1">', owner: "<b>sam</b>" } : c,
      ),
      people: [...d.people, "<b>sam</b>"],
    }));
    const entries = await screen.findAllByTestId("team-entry");
    expect(entries[0]?.textContent).toContain('<img src=x onerror="window.__team=1">');
    expect(document.querySelector("img[src=x]")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
  });

  it("moves focus into the panel when it opens", async () => {
    await open();
    const panel = await screen.findByTestId("team-panel");
    await waitFor(() => expect(document.activeElement).toBe(panel));
  });
});

describe("Team toggle after the data changes under it", () => {
  const refreshAnswer = {
    changed: { files: 0, functions: 0 },
    ms: 0,
    healed: false,
    files: [],
    functions: { added: [], changed: [], removed: [] },
  };
  /** A fetch whose team answer the test can change, like a pull that lands while the page is open. */
  function teamServer(initial: TeamLayerData) {
    let answer = initial;
    const { calls } = installMockFetch((url) => {
      if (url.pathname === "/api/team/layer") return { status: 200, body: answer };
      if (url.pathname === "/api/refresh") return { status: 200, body: refreshAnswer };
      return undefined;
    });
    return { calls, set: (next: TeamLayerData) => (answer = next) };
  }
  const none: TeamLayerData = { available: false, age_s: null, change_sets: [], people: [] };

  afterEach(() => refreshStore.reset());

  it("shows up when a cache is pulled after the page loaded, once the top bar's Refresh has run", async () => {
    const server = teamServer(none);
    window.location.hash = "#/project-map";
    shell(<TeamLayerToggle />);
    await waitFor(() => expect(teamStore.get().loaded).toBe(true));
    expect(screen.queryByTestId("team-toggle")).toBeNull();
    server.set(await teamData());
    await act(async () => {
      await refreshStore.run();
    });
    expect(await screen.findByTestId("team-toggle")).toBeTruthy();
  });

  it("is read again whenever the map appears", async () => {
    const server = teamServer(none);
    window.location.hash = "#/project-map";
    const first = shell(<TeamLayerToggle />);
    await waitFor(() => expect(teamStore.get().loaded).toBe(true));
    first.unmount();
    server.set(await teamData());
    shell(<TeamLayerToggle />);
    expect(await screen.findByTestId("team-toggle")).toBeTruthy();
    expect(server.calls.filter((c) => c.startsWith("/api/team/layer"))).toHaveLength(2);
  });

  it("hides, and switches the layer off, when the cache disappears or now belongs to another repo", async () => {
    const server = teamServer(await teamData());
    window.location.hash = SCENARIO;
    shell(<TeamLayerToggle />);
    fireEvent.click(await screen.findByTestId("team-toggle"));
    expect(teamStore.get().on).toBe(true);
    // The server answers `available: false` for a missing file and for a cache pulled for another repo alike.
    server.set(none);
    await act(async () => {
      await refreshStore.run();
    });
    await waitFor(() => expect(screen.queryByTestId("team-toggle")).toBeNull());
    expect(teamStore.get().on).toBe(false);
  });

  it("keeps the picked change set and people only while they are still in the data", async () => {
    const full = await teamData();
    const server = teamServer(full);
    window.location.hash = SCENARIO;
    await teamStore.load("team");
    act(() => {
      teamStore.setPeople(["tomas"]);
      teamStore.pick("cs:pr:acme/pnpm-turbo#214");
    });
    server.set({ ...full, change_sets: full.change_sets.slice(1), people: ["ines"] });
    await teamStore.load("team");
    expect(teamStore.get().pickedId).toBeNull();
    expect(teamStore.get().people).toEqual([]);
  });
});

describe("team model", () => {
  it("counts the open changes touching each area, with their owners", async () => {
    const data = await teamData();
    const markers = areaMarkers(data.change_sets);
    expect(markers.find((m) => m.id === "ws:@acme/utils")).toEqual({
      id: "ws:@acme/utils",
      count: 1,
      owners: ["ines"],
    });
    const sam = areaMarkers(visibleSets(data, ["tomas"]));
    expect(sam.map((m) => m.id)).toEqual(["ws:@acme/api", "ws:@acme/db"]);
  });

  it("counts radius by tier and has no floor when nothing was cut", async () => {
    const [cs] = (await teamData()).change_sets;
    if (!cs) throw new Error("no change set");
    const c = tierCounts(cs);
    // router.ts and queries.ts are named with their symbols: two changed symbols, not four nodes
    expect(c.changed).toBe(2);
    expect(c.changedFloor).toBe(false);
    expect(cs.nodes_total).toBe(4);
    expect(c.direct + c.potential + c.reachable).toBe(cs.radius.length);
    expect(c.floor).toEqual({ direct: false, potential: false, reachable: false });
  });

  it("puts a floor on the tier the cut fell in and on every tier after it", async () => {
    const [cs] = (await teamData()).change_sets;
    if (!cs) throw new Error("no change set");
    const entry = (i: number, hop: number, tier: "direct" | "potential" | "reachable") => ({
      id: `sym:pnpm-turbo:apps/web/src/gen${i}.ts#g${i}`,
      hop,
      tier,
      via_hub: false,
    });
    // The server keeps the 500 lowest hops: 450 direct and the first 50 of 300 potential.
    const radius = [
      ...Array.from({ length: 450 }, (_, i) => entry(i, 1, "direct")),
      ...Array.from({ length: 50 }, (_, i) => entry(1000 + i, 2, "potential")),
    ];
    const c = tierCounts({ ...cs, radius, radius_total: 750 });
    expect([c.direct, c.potential, c.reachable]).toEqual([450, 50, 0]);
    expect(c.floor).toEqual({ direct: false, potential: true, reachable: true });
    expect(countText(c.direct, c.floor.direct)).toBe("450");
    expect(countText(c.potential, c.floor.potential)).toBe("50+");
    expect(countText(c.reachable, c.floor.reachable)).toBe("0+");
    // A cut that fell in the last tier marks only that tier.
    const reach = Array.from({ length: 500 }, (_, i) => entry(i, 5, "reachable"));
    expect(tierCounts({ ...cs, radius: reach, radius_total: 900 }).floor).toEqual({
      direct: false,
      potential: false,
      reachable: true,
    });
  });

  it("paints changed nodes and their files, and tints the radius by hop but not the changed ones", async () => {
    const [cs] = (await teamData()).change_sets;
    if (!cs) throw new Error("no change set");
    const layer = teamReviewLayer(cs);
    const changed = layer.marks.filter((m) => m.change).map((m) => m.id);
    expect(changed).toContain(ids.listPosts);
    expect(changed).toContain("file:pnpm-turbo:packages/db/src/queries.ts");
    for (const m of layer.marks.filter((x) => x.hop !== undefined)) expect(changed).not.toContain(m.id);
    expect(layer.marks.find((m) => m.id === ids.postList)?.hop).toBe(1);
  });

  it("gives each person a distinct colour that stays the same when a filter narrows the list, and a readable letter", () => {
    const people = ["ana", "maya", "tomas"];
    for (const scheme of ["light", "dark"] as const) {
      const colours = people.map((p) => personColour(people, p, scheme));
      expect(new Set(colours).size).toBe(3);
      expect(personColour(people, "tomas", scheme)).toBe(colours[2]);
    }
    // Every palette entry, both themes: the initial reads on its chip.
    for (const scheme of ["light", "dark"] as const)
      for (let i = 0; i < 12; i++) {
        const { bg, ink } = initialColours(workspaceColorAt(i, scheme), scheme);
        expect(contrastRatio(ink, bg), `${scheme} #${i}`).toBeGreaterThanOrEqual(INITIAL_MIN_CONTRAST);
      }
  });

  it("draws a line only from a direct user to the changed nodes the local graph says it uses", async () => {
    const [cs] = (await teamData()).change_sets;
    if (!cs) throw new Error("no change set");
    // Functions level: every id has a tile. PostList uses createRouter, useDebounce uses listPosts; the two
    // route users in the data have no local edge, so they get no line.
    const lines = teamReviewLayer(cs).links.map((l) => `${l.src} > ${l.dst}`);
    expect(lines.sort()).toEqual(
      [`${ids.useDebounce} > ${ids.listPosts}`, `${ids.postList} > ${ids.createRouter}`].sort(),
    );
    expect(cs.radius.filter((r) => r.tier === "direct").length).toBeGreaterThan(lines.length);
    // Files level: only file tiles exist, and the lines go between the files of those symbols.
    const fileOf = (id: string) => id.replace("sym:", "file:").replace(/#.*/, "");
    const fileTiles = new Set([ids.postList, ids.useDebounce, ids.createRouter, ids.listPosts].map(fileOf));
    const atFiles = teamReviewLayer(cs, (id) => fileTiles.has(id));
    expect(atFiles.links.map((l) => `${l.src} > ${l.dst}`).sort()).toEqual(
      [
        `${fileOf(ids.useDebounce)} > ${fileOf(ids.listPosts)}`,
        `${fileOf(ids.postList)} > ${fileOf(ids.createRouter)}`,
      ].sort(),
    );
    expect(atFiles.linksTotal).toBe(atFiles.links.length);
    // A change set from a server that sends no `direct_uses` draws no lines.
    const { direct_uses: _drop, ...bare } = cs;
    expect(teamReviewLayer(bare as typeof cs).links).toEqual([]);
  });

  describe("reachable and through-hub entries", () => {
    const entry = (id: string, hop: number, tier: "direct" | "potential" | "reachable", via_hub = false) => ({
      id,
      hop,
      tier,
      via_hub,
    });
    /** A tiny tree of four root tiles: PostList, Button, Card and the changed listPosts. */
    const reachOf = (
      cs: Parameters<typeof teamReach>[0],
      radius: ReturnType<typeof entry>[],
      hops: number[] = [0, 0, 0, 0],
    ) => {
      const tree = { ids: [ids.postList, ids.button, ids.card, ids.listPosts], parents: [-1, -1, -1, -1] };
      const paint = {
        change: [null, null, null, "modified"] as ("modified" | null)[],
        hop: Uint8Array.from(hops),
        lit: new Uint8Array(4),
        links: [],
        placed: new Map<string, number>(),
      };
      return { r: teamReach({ ...cs, radius, nodes: [ids.listPosts] }, tree, paint as never), paint };
    };

    it("outlines a reachable entry and names the hub when exactly one entry sits one hop nearer", async () => {
      const [cs] = (await teamData()).change_sets;
      if (!cs) throw new Error("no change set");
      const { r, paint } = reachOf(cs, [
        entry(ids.card, 3, "potential"),
        entry(ids.postList, 4, "reachable"),
        entry(ids.button, 4, "reachable", true),
      ]);
      expect([...r.reach]).toEqual([1, 1, 0, 0]);
      expect(r.hubLabel.get(1)).toBe("through hub Card");
      expect(r.hubLabel.has(0)).toBe(false);
      expect([...paint.lit]).toEqual([1, 1, 0, 0]);
    });

    it("says only 'through a hub' when two or more entries sit one hop nearer", async () => {
      const [cs] = (await teamData()).change_sets;
      if (!cs) throw new Error("no change set");
      const two = [entry(ids.card, 3, "potential"), entry(ids.useDebounce, 3, "potential")];
      expect(hubLabelFor({ ...cs, radius: two }, 4)).toBe("through a hub");
      expect(hubLabelFor({ ...cs, radius: [...two, entry(ids.postList, 3, "potential", true)] }, 4)).toBe(
        "through a hub",
      );
      expect(hubLabelFor({ ...cs, radius: [two[0] as (typeof two)[0]] }, 4)).toBe("through hub Card");
      expect(hubLabelFor({ ...cs, radius: [] }, 4)).toBe("through a hub");
      const { r } = reachOf(cs, [...two, entry(ids.button, 4, "reachable", true)]);
      expect(r.hubLabel.get(1)).toBe("through a hub");
    });

    it("gives a through-hub entry of a nearer tier the hub style too, and keeps its tier's tint", async () => {
      const [cs] = (await teamData()).change_sets;
      if (!cs) throw new Error("no change set");
      // Button is potential (hop 3) and through a hub; the paint already tinted it as a hop-3 node.
      const { r } = reachOf(
        cs,
        [
          entry(ids.card, 2, "potential"),
          entry(ids.button, 3, "potential", true),
          entry(ids.postList, 1, "direct", true),
        ],
        [1, 3, 2, 0],
      );
      expect([...r.reach]).toEqual([2, 2, 0, 0]);
      expect(r.hubLabel.get(1)).toBe("through hub Card");
      expect(r.hubLabel.get(0)).toBe("through a hub");
    });

    it("gives no outline to a node some plain entry reaches", async () => {
      const [cs] = (await teamData()).change_sets;
      if (!cs) throw new Error("no change set");
      const { r } = reachOf(
        cs,
        [entry(ids.button, 3, "potential", true), entry(ids.button, 3, "potential")],
        [0, 3, 0, 0],
      );
      expect(r.hubLabel.size).toBe(0);
      expect([...r.reach]).toEqual([0, 0, 0, 0]);
    });
  });

  it("draws a hollow dot for a through-hub entry in any tier", async () => {
    const [cs] = (await teamData()).change_sets;
    if (!cs) throw new Error("no change set");
    const radius = [
      { id: ids.postList, hop: 1, tier: "direct" as const, via_hub: true },
      { id: ids.useDebounce, hop: 1, tier: "direct" as const, via_hub: false },
      { id: ids.card, hop: 2, tier: "potential" as const, via_hub: true },
      { id: ids.button, hop: 2, tier: "potential" as const, via_hub: true },
      { id: ids.createRouter, hop: 4, tier: "reachable" as const, via_hub: false },
    ];
    const { container } = render(<TeamLayerRings set={{ ...cs, radius, radius_total: radius.length }} />);
    const hollow = (tier: string) => container.querySelectorAll(`.team-radar-dot.is-${tier}.is-hub`).length;
    expect(hollow("direct")).toBe(1);
    expect(hollow("potential")).toBe(2);
    expect(hollow("reachable")).toBe(0);
    expect(container.querySelectorAll(".team-radar-dot.is-potential")).toHaveLength(2);
  });

  it("works out the current age from the age at the read and the time since", () => {
    expect(currentAge(720, 1_000_000, 1_000_000 + 125_000)).toBe(845);
    expect(currentAge(null, 1_000_000, 2_000_000)).toBeNull();
    expect(currentAge(10, null, 5)).toBe(10);
  });

  it("says how long ago in words", () => {
    expect(ageWords(30)).toBe("under a minute");
    expect(ageWords(720)).toBe("12 min");
    expect(ageWords(3 * 3600)).toBe("3 h");
    expect(ageWords(3 * 86400)).toBe("3 days");
  });
});

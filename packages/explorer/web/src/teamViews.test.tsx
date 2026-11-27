// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { handleMockOverlayWrite } from "../mock/overlay.ts";
import { mockTeamViews } from "../mock/teamViews.ts";
import type { TeamViewsData } from "./api.ts";
import "./canvases.ts";
import { installMockFetch, renderApp } from "./testUtils.tsx";

const TEAM = "#/project-map?scenario=team";
const SPEC = { view: "project-map", level: "files", hidden: [], groups: [], filters: {} };

/** A saved view of the person's own, in the mock overlay. */
function ownView(id: string, name: string) {
  handleMockOverlayWrite("PUT", `/api/overlay/views/${id}`, { name, spec: SPEC });
}

const trigger = () => screen.findByRole("button", { name: /^Saved view/ });
async function openMenu() {
  fireEvent.click(await trigger());
  return screen.findByRole("menu", { name: "Saved views" });
}
const mineOf = (menu: HTMLElement) => within(menu).getByRole("group", { name: "Your views" });
const teamGroup = (menu: HTMLElement) => within(menu).getByTestId("team-group");

describe("the saved-views menu with a team cache", () => {
  it("lists your views, then a Team heading with the team's views, the default marked", async () => {
    ownView("api-trace", "Api trace");
    installMockFetch();
    renderApp(TEAM);
    const menu = await openMenu();
    const mine = within(menu).getByRole("group", { name: "Your views" });
    expect(within(mine).getByText("Api trace")).toBeTruthy();
    const team = teamGroup(menu);
    expect(within(team).getByText("Team")).toBeTruthy();
    expect(within(team).getByTestId("views-pulled").textContent).toBe("pulled 12 min ago");
    const names = within(team)
      .getAllByTestId("team-view-item")
      .map((b) => b.textContent);
    expect(names).toHaveLength(3);
    expect(names.join("|")).toContain("Ownership map");
    // Your views come before the Team heading in the menu.
    expect(mine.compareDocumentPosition(team) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The default carries the badge and is announced as the team default; the others do not.
    const badges = within(menu).getAllByTestId("default-badge");
    expect(badges).toHaveLength(1);
    const item = badges[0]?.closest("button");
    expect(item?.textContent).toContain("Ownership map");
    expect(item?.textContent).toContain("Team default");
    // `Save view…` stays at the bottom, as before.
    expect(within(menu).getByRole("menuitem", { name: "Save view…" })).toBeTruthy();
  });

  it("marks the Team heading's age in the warning style after 24 hours", async () => {
    const stale: TeamViewsData = { ...mockTeamViews("team"), age_s: 25 * 3600 };
    installMockFetch((url) =>
      url.pathname === "/api/team/views" ? { status: 200, body: stale } : undefined,
    );
    renderApp(TEAM);
    const menu = await openMenu();
    const pulled = within(menu).getByTestId("views-pulled");
    expect(pulled.textContent).toBe("pulled 25 h ago");
    expect(pulled.className).toContain("views-stale");
  });

  it("opens a team view when it is picked, with the choice remembered", async () => {
    const { calls } = installMockFetch();
    renderApp(TEAM);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Data layer/ }));
    await waitFor(() => expect(window.location.hash).toContain("saved=data-layer"));
    // The pick goes to the explorer's server (a file in its data directory), not to the browser's storage.
    await waitFor(() => expect(calls).toContain('PUT /api/team/last-view {"id":"data-layer"}'));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renders a name as text, never as markup", async () => {
    const data = mockTeamViews("team");
    const evil = "<img src=x onerror=alert(1)>";
    const hostile: TeamViewsData = {
      ...data,
      views: data.views.map((v) => (v.id === "data-layer" ? { ...v, name: evil } : v)),
    };
    installMockFetch((url) =>
      url.pathname === "/api/team/views" ? { status: 200, body: hostile } : undefined,
    );
    renderApp(TEAM);
    const menu = await openMenu();
    expect(within(menu).getByText(evil)).toBeTruthy();
    expect(menu.querySelector("img")).toBeNull();
  });

  it("moves with the arrow keys, selects with Enter and closes with Escape, returning focus to the button", async () => {
    installMockFetch();
    renderApp(TEAM);
    const button = await trigger();
    fireEvent.keyDown(button, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu", { name: "Saved views" });
    const items = () => [...menu.querySelectorAll<HTMLElement>("[data-menu-item]")];
    await waitFor(() => expect(items()).toContain(document.activeElement));
    const first = document.activeElement as HTMLElement;
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items()[1]);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items().at(-1));
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
    // Enter on a row (a button) picks it.
    fireEvent.keyDown(button, { key: "ArrowDown" });
    const again = await screen.findByRole("menu", { name: "Saved views" });
    const row = within(again).getByRole("menuitemradio", { name: /Public API surface/ });
    row.focus();
    fireEvent.click(row); // a browser turns Enter on a focused button into this click
    await waitFor(() => expect(window.location.hash).toContain("saved=public-api-surface"));
  });
});

describe("opening on the team default", () => {
  const withTeam = (lastView: string | null = null) =>
    installMockFetch((url) =>
      url.pathname === "/api/team/views"
        ? { status: 200, body: { ...mockTeamViews("team"), last_view: lastView } }
        : undefined,
    );

  it("opens a session that has chosen nothing on the default view", async () => {
    withTeam();
    renderApp("");
    await waitFor(() => expect(window.location.hash).toContain("saved=ownership-map"));
    expect(await screen.findByRole("button", { name: /^Saved view/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Saved view/ }).textContent).toContain("Ownership map");
  });

  it("opens on your own last choice in a later session", async () => {
    withTeam("data-layer");
    renderApp("");
    await waitFor(() => expect(window.location.hash).toContain("saved=data-layer"));
  });

  it("falls back to the default when the remembered view is gone", async () => {
    withTeam("deleted-long-ago");
    renderApp("");
    await waitFor(() => expect(window.location.hash).toContain("saved=ownership-map"));
  });

  it("leaves a link that names a view alone", async () => {
    withTeam();
    renderApp("#/project-map?level=workspaces");
    await screen.findByRole("button", { name: /^Saved view/ });
    expect(window.location.hash).not.toContain("saved=");
  });
});

describe("a team view is read-only", () => {
  it("shows the note and Save a personal copy, and the copy is a view of your own that opens", async () => {
    const { calls } = installMockFetch();
    renderApp(`${TEAM}&saved=data-layer`);
    const bar = await screen.findByRole("region", { name: "Team view" });
    expect(within(bar).getByText("Data layer")).toBeTruthy();
    expect(within(bar).getByText("Team view: read-only")).toBeTruthy();
    fireEvent.click(within(bar).getByRole("button", { name: "Save a personal copy" }));
    await waitFor(() =>
      expect(calls.some((c) => c.startsWith("PUT /api/overlay/views/data-layer-copy "))).toBe(true),
    );
    // The new id, not the team view's, and the bar is gone because the open view is now your own.
    await waitFor(() => expect(window.location.hash).toContain("saved=data-layer-copy"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Team view" })).toBeNull());
    const menu = await openMenu();
    expect(
      within(within(menu).getByRole("group", { name: "Your views" })).getByText("Data layer copy"),
    ).toBeTruthy();
  });

  it("moves focus to the switcher after Save a personal copy, and the switcher names the copy", async () => {
    installMockFetch();
    renderApp(`${TEAM}&saved=data-layer`);
    const bar = await screen.findByRole("region", { name: "Team view" });
    const save = within(bar).getByRole("button", { name: "Save a personal copy" });
    save.focus();
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Team view" })).toBeNull());
    const button = await trigger();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-label")).toBe("Saved view: Data layer copy");
  });

  it("gives the switcher an accessible name that holds the open view's visible name", async () => {
    installMockFetch();
    renderApp(`${TEAM}&saved=data-layer`);
    const button = await screen.findByRole("button", { name: "Saved view: Data layer" });
    expect(button.textContent).toContain("Data layer");
    expect(button.getAttribute("aria-label")?.endsWith(button.textContent?.trim() ?? "?")).toBe(true);
  });

  it("shows no bar for a view of your own", async () => {
    ownView("api-trace", "Api trace");
    installMockFetch();
    renderApp(`${TEAM}&saved=api-trace`);
    await trigger();
    expect(screen.queryByRole("region", { name: "Team view" })).toBeNull();
  });
});

describe("publishing a view or group", () => {
  it("publishes your view, shows the line and the marker, and removes it again", async () => {
    ownView("api-trace", "Api trace");
    const { calls } = installMockFetch();
    renderApp(TEAM);
    let menu = await openMenu();
    expect(within(menu).queryByTestId("published-marker")).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "More actions for Api trace" }));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Publish to team" }));
    await waitFor(() => expect(calls).toContain("POST /api/team/views/api-trace/publish {}"));
    await waitFor(() =>
      expect(within(menu).getByTestId("views-result").textContent).toBe("Published to team."),
    );
    await waitFor(() => expect(within(menu).getByTestId("published-marker")).toBeTruthy());
    // It stays under Your views and is not repeated under Team.
    expect(within(teamGroup(menu)).getAllByTestId("team-view-item")).toHaveLength(3);
    expect(within(mineOf(menu)).getAllByText("Api trace")).toHaveLength(1);
    menu = screen.getByRole("menu", { name: "Saved views" });
    fireEvent.click(within(mineOf(menu)).getByRole("menuitem", { name: "More actions for Api trace" }));
    expect(within(menu).queryByRole("menuitem", { name: "Publish to team" })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Remove from team" }));
    await waitFor(() => expect(calls).toContain("DELETE /api/team/views/api-trace/publish"));
    await waitFor(() => expect(within(menu).queryByTestId("published-marker")).toBeNull());
  });

  it("brings focus back to the row's … button after an action, so the keys keep working", async () => {
    ownView("api-trace", "Api trace");
    installMockFetch();
    renderApp(TEAM);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "More actions for Api trace" }));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Publish to team" }));
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe(
      "More actions for Api trace",
    );
    await waitFor(() =>
      expect(within(menu).getByTestId("views-result").textContent).toBe("Published to team."),
    );
    expect(menu.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens your published view as your own: checked in your list, no read-only bar", async () => {
    ownView("api-trace", "Api trace");
    installMockFetch();
    renderApp(TEAM);
    let menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "More actions for Api trace" }));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Publish to team" }));
    await waitFor(() => expect(within(menu).getByTestId("published-marker")).toBeTruthy());
    fireEvent.click(within(mineOf(menu)).getByRole("menuitemradio", { name: /Api trace/ }));
    await waitFor(() => expect(window.location.hash).toContain("saved=api-trace"));
    expect(screen.queryByRole("region", { name: "Team view" })).toBeNull();
    menu = await openMenu();
    expect(
      within(mineOf(menu))
        .getByRole("menuitemradio", { name: /Api trace/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(within(teamGroup(menu)).queryByText("Api trace")).toBeNull();
  });

  it("treats a team view with your view's id but other content as someone else's: both listed, the team's read-only", async () => {
    handleMockOverlayWrite("PUT", "/api/overlay/views/data-layer", { name: "My data layer", spec: SPEC });
    installMockFetch();
    renderApp(`${TEAM}&saved=data-layer`);
    const bar = await screen.findByRole("region", { name: "Team view" });
    expect(within(bar).getByText("Data layer")).toBeTruthy();
    const menu = await openMenu();
    expect(within(mineOf(menu)).getByText("My data layer")).toBeTruthy();
    expect(within(mineOf(menu)).queryByTestId("published-marker")).toBeNull();
    expect(within(teamGroup(menu)).getByText("Data layer")).toBeTruthy();
    expect(
      within(teamGroup(menu))
        .getByRole("menuitemradio", { name: /Data layer/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("keeps the result lines in the page before any result, empty and visible to a screen reader", async () => {
    installMockFetch();
    renderApp(TEAM);
    const curation = await screen.findByRole("region", { name: "Curation" });
    const groupLine = within(curation).getByTestId("group-result");
    expect(groupLine.getAttribute("aria-live")).toBe("polite");
    expect(groupLine.textContent).toBe("");
    const menu = await openMenu();
    const line = within(menu).getByTestId("views-result");
    expect(line.getAttribute("aria-live")).toBe("polite");
    expect(line.textContent).toBe("");
    expect(line.hasAttribute("hidden")).toBe(false);
  });

  it("keeps the item as it was and shows the reason when the server refuses", async () => {
    ownView("api-trace", "Api trace");
    installMockFetch();
    // The mock's write handler answers first, so the refusal is put in front of it.
    const mock = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/api/team/views/api-trace/publish")
        ? Promise.resolve(
            new Response(JSON.stringify({ error: "This team does not take new views." }), {
              status: 403,
              headers: { "content-type": "application/json" },
            }),
          )
        : mock(input, init),
    );
    renderApp(TEAM);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "More actions for Api trace" }));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Publish to team" }));
    const line = within(menu).getByTestId("views-result");
    await waitFor(() => expect(line.textContent).toBe("This team does not take new views."));
    expect(within(line).getByTestId("views-result-line").getAttribute("data-tone")).toBe("error");
    expect(line.getAttribute("aria-live")).toBe("polite");
    expect(within(menu).queryByTestId("published-marker")).toBeNull();
    expect(within(menu).getByText("Api trace")).toBeTruthy();
  });

  it("publishes a group of yours, and shows a member's refusal when a team group is removed", async () => {
    handleMockOverlayWrite("PUT", "/api/overlay/groups/invoicing", {
      name: "Invoicing",
      selectors: [{ type: "glob", glob: "apps/api/**" }],
      mayUse: null,
    });
    const { calls } = installMockFetch();
    renderApp(TEAM);
    const curation = await screen.findByRole("region", { name: "Curation" });
    const own = await within(curation).findByRole("list", { name: "Groups" });
    fireEvent.click(within(own).getByRole("button", { name: "Publish to team" }));
    await waitFor(() => expect(calls).toContain("POST /api/team/groups/invoicing/publish {}"));
    await waitFor(() =>
      expect(within(curation).getByTestId("group-result").textContent).toBe("Published to team."),
    );
    // It stays in your list, marked Published, and is not repeated under Team groups; no shadow note for an equal copy.
    await waitFor(() => expect(within(own).getByTestId("group-published-marker")).toBeTruthy());
    expect(within(own).queryByTestId("shadowed-note")).toBeNull();
    expect(within(own).getByRole("button", { name: "Remove from team" })).toBeTruthy();
    const teamGroups = within(curation).getByRole("list", { name: "Team groups" });
    expect(within(teamGroups).getAllByText("Team group: read-only")).toHaveLength(2);
    const frontend = within(teamGroups).getByText("Frontend").closest("li") as HTMLElement;
    fireEvent.click(within(frontend).getByRole("button", { name: "Remove from team" }));
    await waitFor(() =>
      expect(within(curation).getByTestId("group-result").textContent).toBe(
        "Removing a team group needs an admin.",
      ),
    );
    expect(within(curation).getByTestId("group-result-line").getAttribute("data-tone")).toBe("error");
    expect(within(teamGroups).getAllByText("Team group: read-only")).toHaveLength(2);
  });

  it("keeps focus on a group's publish button while it works (aria-disabled, not disabled) and ignores a second click", async () => {
    handleMockOverlayWrite("PUT", "/api/overlay/groups/invoicing", {
      name: "Invoicing",
      selectors: [{ type: "glob", glob: "apps/api/**" }],
      mayUse: null,
    });
    const { calls } = installMockFetch();
    const mock = globalThis.fetch;
    let release: () => void = () => {};
    const held = new Promise<void>((ok) => {
      release = ok;
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/groups/invoicing/publish")) await held;
      return mock(input, init);
    });
    renderApp(TEAM);
    const curation = await screen.findByRole("region", { name: "Curation" });
    const own = await within(curation).findByRole("list", { name: "Groups" });
    const button = within(own).getByRole("button", { name: "Publish to team" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBe("true"));
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    release();
    await waitFor(() =>
      expect(within(curation).getByTestId("group-result").textContent).toBe("Published to team."),
    );
    expect(calls.filter((c) => c.startsWith("POST /api/team/groups/invoicing/publish"))).toHaveLength(1);
  });

  it("moves focus to the Team groups heading when a removed team group's row goes", async () => {
    installMockFetch();
    renderApp(TEAM);
    const curation = await screen.findByRole("region", { name: "Curation" });
    const teamGroups = await within(curation).findByRole("list", { name: "Team groups" });
    const row = within(teamGroups).getByText("Data access").closest("li") as HTMLElement;
    const remove = within(row).getByRole("button", { name: "Remove from team" });
    remove.focus();
    fireEvent.click(remove);
    await waitFor(() => expect(within(teamGroups).queryByText("Data access")).toBeNull());
    await waitFor(() =>
      expect(within(curation).getByTestId("group-result").textContent).toBe("Removed from team."),
    );
    expect(document.activeElement?.textContent).toBe("Team groups");
    expect(curation.contains(document.activeElement)).toBe(true);
  });

  it("keeps focus inside the menu when a team view's row goes after Remove from team", async () => {
    installMockFetch();
    renderApp(TEAM);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "More actions for Data layer" }));
    const remove = within(menu).getByRole("menuitem", { name: "Remove from team" });
    remove.focus();
    fireEvent.click(remove);
    await waitFor(() => expect(within(teamGroup(menu)).queryByText("Data layer")).toBeNull());
    await waitFor(() =>
      expect(within(menu).getByTestId("views-result").textContent).toBe("Removed from team."),
    );
    expect(menu.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("notes a local group that a team group with other content shadows", async () => {
    handleMockOverlayWrite("PUT", "/api/overlay/groups/frontend", {
      name: "My frontend",
      selectors: [{ type: "glob", glob: "apps/web/src/**" }],
      mayUse: null,
    });
    installMockFetch();
    renderApp(`${TEAM}&sel=${encodeURIComponent("sym:pnpm-turbo:packages/ui/src/button.tsx#Button")}`);
    const curation = await screen.findByRole("region", { name: "Curation" });
    const own = await within(curation).findByRole("list", { name: "Groups" });
    expect(within(own).getByTestId("shadowed-note").textContent).toBe("shadowed by the team group");
    expect(within(own).queryByTestId("group-published-marker")).toBeNull();
  });

  it("saves a personal copy of a team group with a new id", async () => {
    const { calls } = installMockFetch();
    renderApp(TEAM);
    const curation = await screen.findByRole("region", { name: "Curation" });
    const teamGroups = await within(curation).findByRole("list", { name: "Team groups" });
    fireEvent.click(
      within(teamGroups).getAllByRole("button", { name: "Save a personal copy" })[0] as HTMLElement,
    );
    await waitFor(() =>
      expect(calls.some((c) => c.startsWith("PUT /api/overlay/groups/data-access-copy "))).toBe(true),
    );
    const body = calls.find((c) => c.startsWith("PUT /api/overlay/groups/data-access-copy ")) ?? "";
    expect(body).not.toContain("origin");
  });
});

describe("without a team cache", () => {
  it("keeps the saved-view select exactly as it was, with no Team heading and no publish items", async () => {
    ownView("api-trace", "Api trace");
    const { calls } = installMockFetch();
    renderApp("#/project-map");
    const select = await screen.findByRole("combobox", { name: "Saved view" });
    await waitFor(() => expect(calls.some((c) => c.startsWith("/api/team/views"))).toBe(true));
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "Saved views",
      "Api trace",
      "Save view…",
      "Reset curation…",
    ]);
    expect(screen.queryByRole("button", { name: /^Saved view/ })).toBeNull();
    expect(screen.queryByText("Team")).toBeNull();
    expect(screen.queryByText("Publish to team")).toBeNull();
    expect(screen.queryByTestId("team-view-bar")).toBeNull();
  });

  it("treats a server without the route as no cache", async () => {
    installMockFetch((url) => (url.pathname === "/api/team/views" ? { status: 404, body: {} } : undefined));
    renderApp("#/project-map");
    expect(await screen.findByRole("combobox", { name: "Saved view" })).toBeTruthy();
  });
});

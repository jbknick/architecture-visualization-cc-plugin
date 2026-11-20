// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ids } from "../../mock/fixture.ts";
import { uniqueId } from "../curation.ts";
import "../canvases.ts";
import { installMockFetch, renderApp } from "../testUtils.tsx";

const BUTTON = ids.button;
const open = (id: string) => `#/project-map?sel=${encodeURIComponent(id)}`;
const inspector = () => screen.findByRole("complementary", { name: "Inspector" });

describe("curation ids", () => {
  it("makes a slug and gives a taken one -2, -3", () => {
    expect(uniqueId("Web Dates!", [])).toBe("web-dates");
    expect(uniqueId("Dates", ["dates"])).toBe("dates-2");
    expect(uniqueId("Dates", ["dates", "dates-2"])).toBe("dates-3");
    expect(uniqueId("???", [])).toBeNull();
  });
});

describe("curation in the inspector", () => {
  it("Rename saves the label through PUT /api/overlay/labels and shows it with the original name", async () => {
    const { calls } = installMockFetch();
    renderApp(open(BUTTON));
    const aside = await inspector();
    fireEvent.click(await within(aside).findByRole("button", { name: "Rename" }));
    fireEvent.change(within(aside).getByRole("textbox", { name: "Label" }), {
      target: { value: "Primary button" },
    });
    fireEvent.submit(within(aside).getByRole("textbox", { name: "Label" }).closest("form") as HTMLElement);
    await waitFor(() =>
      expect(calls).toContain(
        `PUT /api/overlay/labels ${JSON.stringify({ nodeId: BUTTON, text: "Primary button" })}`,
      ),
    );
    expect(await within(aside).findByRole("heading", { name: "Primary button" })).toBeTruthy();
    expect(within(aside).getByText(/Original name/)).toBeTruthy();
    // The Curation section lists it, and its remove button undoes it.
    const curation = screen.getByRole("region", { name: "Curation" });
    fireEvent.click(await within(curation).findByRole("button", { name: "Remove name Primary button" }));
    await waitFor(() => expect(within(curation).queryByText("Primary button")).toBeNull());
  });

  it("Hide posts an ids selector, and Show again takes it back", async () => {
    const { calls } = installMockFetch();
    renderApp(open(BUTTON));
    const aside = await inspector();
    fireEvent.click(await within(aside).findByRole("button", { name: "Hide" }));
    await waitFor(() =>
      expect(calls).toContain(
        `PUT /api/overlay/hidden ${JSON.stringify({ selectors: [{ type: "ids", ids: [BUTTON] }] })}`,
      ),
    );
    const curation = screen.getByRole("region", { name: "Curation" });
    fireEvent.click(await within(curation).findByRole("button", { name: "Show again" }));
    await waitFor(() =>
      expect(calls).toContain(`PUT /api/overlay/hidden ${JSON.stringify({ selectors: [] })}`),
    );
  });

  it("New group… creates a group from the node, and a second group with the same name gets -2", async () => {
    const { calls } = installMockFetch();
    renderApp(open(BUTTON));
    const aside = await inspector();
    const create = async (name: string) => {
      fireEvent.change(await within(aside).findByRole("combobox", { name: "Group" }), {
        target: { value: "\u0000new-group" },
      });
      const dialog = await screen.findByRole("dialog", { name: "New group" });
      fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: name } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "New group" })).toBeNull());
    };
    await create("Dates");
    await create("Dates");
    const puts = calls.filter((c) => c.startsWith("PUT /api/overlay/groups/"));
    expect(puts.map((c) => c.split(" ")[1])).toEqual([
      "/api/overlay/groups/dates",
      "/api/overlay/groups/dates-2",
    ]);
    expect(puts[0]).toContain(JSON.stringify({ type: "ids", ids: [BUTTON] }));
    const groups = within(screen.getByRole("region", { name: "Curation" })).getByRole("list", {
      name: "Groups",
    });
    expect(within(groups).getAllByText("Dates")).toHaveLength(2);
  });
});

describe("saved views in the top bar", () => {
  it("saves the current picture under a name, lists it and navigates to it", async () => {
    const { calls } = installMockFetch();
    renderApp("#/project-map?level=files");
    const select = await screen.findByRole("combobox", { name: "Saved view" });
    expect(within(select).queryByRole("option", { name: "Curated" })).toBeNull();
    fireEvent.change(select, { target: { value: "\u0000save" } });
    const dialog = await screen.findByRole("dialog", { name: "Save view" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Curated" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls).toContain(
        `PUT /api/overlay/views/curated ${JSON.stringify({
          name: "Curated",
          spec: { view: "project-map", level: "files", hidden: [], groups: [], filters: {} },
        })}`,
      ),
    );
    expect(await within(select).findByRole("option", { name: "Curated" })).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toContain("saved=curated"));
    // Switching to the view from another one goes to #/<view>?saved=<id>.
    window.location.hash = "#/ego";
    await waitFor(() => expect(window.location.hash).toBe("#/ego"));
    fireEvent.change(select, { target: { value: "curated" } });
    await waitFor(() => expect(window.location.hash).toBe("#/project-map?saved=curated"));
  });

  it("Reset curation… asks first, then posts the reset", async () => {
    const { calls } = installMockFetch();
    renderApp("#/project-map");
    const select = await screen.findByRole("combobox", { name: "Saved view" });
    fireEvent.change(select, { target: { value: "\u0000reset" } });
    const dialog = await screen.findByRole("dialog", { name: "Reset curation" });
    expect(calls.some((c) => c.startsWith("POST /api/overlay/reset"))).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(calls.some((c) => c.startsWith("POST /api/overlay/reset"))).toBe(true));
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RankedFile } from "../rankedFiles/rank.ts";
import { LargestFiles } from "./LargestFiles.tsx";

afterEach(cleanup);

const files: RankedFile[] = [
  {
    rank: 1,
    id: "file:apps/api/src/routes/orderService.ts",
    name: "orderService.ts",
    functions: 120,
    path: "apps/api/src/routes/orderService.ts",
    workspaceId: "ws:api",
    workspace: "api",
    folder: "routes",
  },
  {
    rank: 2,
    id: "file:apps/web/index.ts",
    name: "index.ts",
    functions: 40,
    path: "apps/web/index.ts",
    workspaceId: "ws:web",
    workspace: "web",
    folder: "",
  },
];

function setup(over: Partial<Parameters<typeof LargestFiles>[0]> = {}) {
  const props = {
    files,
    scope: null,
    scopes: [
      { id: "ws:api", label: "api" },
      { id: "ws:web", label: "web" },
    ],
    onScope: vi.fn(),
    colorOf: () => "#2f6fdb",
    onSelect: vi.fn(),
    onFocus: vi.fn(),
    onHover: vi.fn(),
    ...over,
  };
  render(<LargestFiles {...props} />);
  return props;
}

describe("LargestFiles", () => {
  it("shows a numbered row per file with its count and where it lives", () => {
    setup();
    const rows = screen.getAllByRole("button");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("1");
    expect(rows[0]?.textContent).toContain("orderService.ts");
    expect(rows[0]?.textContent).toContain("120 fn");
    expect(rows[0]?.textContent).toContain("api › routes");
    expect(rows[1]?.textContent).toContain("web");
    expect(rows[1]?.textContent).not.toContain("›");
  });

  it("selects and focuses a file when its row is clicked", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: /orderService\.ts/ }));
    expect(p.onSelect).toHaveBeenCalledWith("file:apps/api/src/routes/orderService.ts");
    expect(p.onFocus).toHaveBeenCalledWith("file:apps/api/src/routes/orderService.ts");
  });

  it("reports the hovered row and clears it on leave", () => {
    const p = setup();
    const row = screen.getByRole("button", { name: /index\.ts/ });
    fireEvent.mouseEnter(row);
    expect(p.onHover).toHaveBeenLastCalledWith("file:apps/web/index.ts");
    fireEvent.mouseLeave(row);
    expect(p.onHover).toHaveBeenLastCalledWith(null);
  });

  it("restricts the ranking through the workspace menu", () => {
    const p = setup();
    fireEvent.change(screen.getByLabelText("Top files in"), { target: { value: "ws:web" } });
    expect(p.onScope).toHaveBeenCalledWith("ws:web");
    fireEvent.change(screen.getByLabelText("Top files in"), { target: { value: "" } });
    expect(p.onScope).toHaveBeenLastCalledWith(null);
  });
});

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@gantry/core";
import { afterEach, describe, expect, it } from "vitest";
import { getLayout, putLayout } from "./layout.js";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("saved layout positions (overlay.layouts)", () => {
  it("survive deleting and rebuilding gantry.db", () => {
    dir = mkdtempSync(join(tmpdir(), "gantry-layout-"));
    const dbPath = join(dir, "gantry.db");
    const positions = { "ws:.": [1.5, -2], "ws:lib": [30, 40] };

    let store = openStore(dbPath);
    expect(putLayout(store, "project-map", { positions })).toEqual({ saved: 2 });
    store.close();

    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
    expect(existsSync(dbPath)).toBe(false);

    store = openStore(dbPath);
    expect(getLayout(store, "project-map").positions).toEqual(positions);
    store.close();
  });
});

import { rmSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { GantryConfig, GantryPaths, Store } from "@gantry/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ExplorerServer, startExplorerServer } from "./index.js";
import { fixtureStore } from "./testkit.js";
import type { GraphNode, ViewResult } from "./types.js";

type Overlayed = ViewResult & {
  overlay: { hidden: number; groups: { id: string; name: string; members: string[] }[] };
};

const WEB_SLUG = "file:pnpm-turbo:apps/web/src/lib/slug.ts";
const INTERNAL = "packages/ui/src/internal.ts";

let dir: string;
let store: Store;
let srv: ExplorerServer;

const paths = (): GantryPaths => ({ root: dir, dataDir: dir, dbPath: join(dir, "gantry.db") }) as GantryPaths;
const url = (p: string) => `http://127.0.0.1:${srv.port}${p}`;
const headers = (extra: Record<string, string> = {}) => ({ "x-gantry-token": srv.token, ...extra });
const json = { "content-type": "application/json" };
const send = (method: string, p: string, body?: unknown, extra: Record<string, string> = json) =>
  fetch(url(p), {
    method,
    headers: headers(extra),
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
const view = async (q: string): Promise<Overlayed> =>
  (await (await fetch(url(`/api/view/project-map${q}`), { headers: headers() })).json()) as Overlayed;
const reset = () => send("POST", "/api/overlay/reset", {});

beforeAll(async () => {
  ({ store, dir } = fixtureStore("pnpm-turbo"));
  srv = await startExplorerServer({
    paths: paths(),
    store,
    config: {} as GantryConfig,
    writeStateFile: false,
  });
});
afterAll(async () => {
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("overlay routes", () => {
  it("GET /api/overlay starts empty", async () => {
    await reset();
    const r = await fetch(url("/api/overlay"), { headers: headers() });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ labels: [], hidden: [], groups: [], views: [], unresolved: [] });
  });

  it("PUT labels: 200, 400 on a bad body, 404 for an unknown node, and empty text removes", async () => {
    await reset();
    const ok = await send("PUT", "/api/overlay/labels", { nodeId: WEB_SLUG, text: "Web slug helper" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ labels: [{ nodeId: WEB_SLUG, text: "Web slug helper" }] });
    const bad = await send("PUT", "/api/overlay/labels", { nodeId: WEB_SLUG, text: "x".repeat(81) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/^text: /);
    expect((await send("PUT", "/api/overlay/labels", { nodeId: WEB_SLUG, text: "a", extra: 1 })).status).toBe(
      400,
    );
    expect(
      (await send("PUT", "/api/overlay/labels", { nodeId: "file:pnpm-turbo:nope.ts", text: "a" })).status,
    ).toBe(404);
    const gone = await send("PUT", "/api/overlay/labels", { nodeId: WEB_SLUG, text: "" });
    expect(await gone.json()).toEqual({ labels: [] });
  });

  it("PUT hidden: 200 and 400", async () => {
    await reset();
    const sel = [{ type: "glob", glob: INTERNAL }];
    const ok = await send("PUT", "/api/overlay/hidden", { selectors: sel });
    expect(await ok.json()).toEqual({ hidden: sel });
    expect((await send("PUT", "/api/overlay/hidden", { selectors: [{ type: "regex" }] })).status).toBe(400);
    expect((await send("PUT", "/api/overlay/hidden", {})).status).toBe(400);
  });

  it("PUT and DELETE groups", async () => {
    await reset();
    const body = { name: "Dates", selectors: [{ type: "kind", kind: "file" }], mayUse: null };
    const ok = await send("PUT", "/api/overlay/groups/dates", body);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ group: { id: "dates", ...body } });
    const withId = await send("PUT", "/api/overlay/groups/dates", { ...body, id: "dates" });
    expect(withId.status).toBe(400);
    expect((await send("PUT", "/api/overlay/groups/Bad", { name: "x", selectors: [] })).status).toBe(400);
    expect((await send("PUT", "/api/overlay/groups/Bad", body)).status).toBe(400);
    const del = await send("DELETE", "/api/overlay/groups/dates");
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: "dates" });
    expect((await send("DELETE", "/api/overlay/groups/dates")).status).toBe(404);
  });

  it("PUT and DELETE views; spec.view must be a registered view", async () => {
    await reset();
    const spec = { view: "project-map", level: "files", hidden: [], groups: [], filters: {} };
    const ok = await send("PUT", "/api/overlay/views/curated", { name: "Curated", spec });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ view: { id: "curated", name: "Curated", spec } });
    const unknown = await send("PUT", "/api/overlay/views/other", {
      name: "O",
      spec: { ...spec, view: "nope" },
    });
    expect(unknown.status).toBe(400);
    expect((await send("DELETE", "/api/overlay/views/curated")).status).toBe(200);
    expect((await send("DELETE", "/api/overlay/views/curated")).status).toBe(404);
  });

  it("POST reset empties the overlay", async () => {
    await send("PUT", "/api/overlay/labels", { nodeId: WEB_SLUG, text: "x" });
    const r = await send("POST", "/api/overlay/reset", {});
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ labels: [], hidden: [], groups: [], views: [] });
    expect((await send("POST", "/api/overlay/reset", { extra: 1 })).status).toBe(400);
  });

  it("answers 405, 413, 415 and 403 like the rest of the API", async () => {
    // Other methods and paths keep the read-only allow-list.
    for (const [m, p] of [
      ["PUT", "/api/overlay"],
      ["POST", "/api/overlay/labels"],
      ["DELETE", "/api/overlay"],
      ["DELETE", "/api/overlay/labels"],
      ["PUT", "/api/overlay/groups/a/b"],
      ["PATCH", "/api/overlay/groups/a"],
    ] as const) {
      const r = await send(m, p, "{}");
      expect(r.status, `${m} ${p}`).toBe(405);
      expect(r.headers.get("allow")).toBe("GET, HEAD");
    }
    expect(
      (await send("PUT", "/api/overlay/hidden", { selectors: [] }, { "content-type": "text/plain" })).status,
    ).toBe(415);
    expect((await send("PUT", "/api/overlay/hidden", { selectors: [] }, {})).status).toBe(415);
    const big = JSON.stringify({ selectors: [{ type: "glob", glob: "a".repeat(70 * 1024) }] });
    // The server answers 413 and may cut the connection while the body is still being sent.
    const tooBig = await send("PUT", "/api/overlay/hidden", big).then(
      (r) => r.status,
      () => 413,
    );
    expect(tooBig).toBe(413);
    expect((await send("PUT", "/api/overlay/hidden", "{nope")).status).toBe(400);
    // Token, Origin and Host checks.
    const noToken = await fetch(url("/api/overlay/hidden"), {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ selectors: [] }),
    });
    expect(noToken.status).toBe(403);
    expect((await fetch(url("/api/overlay"))).status).toBe(403);
    expect((await fetch(url("/api/overlay/groups/a"), { method: "DELETE" })).status).toBe(403);
    const badOrigin = await send(
      "PUT",
      "/api/overlay/hidden",
      { selectors: [] },
      { ...json, origin: "http://evil.example" },
    );
    expect(badOrigin.status).toBe(403);
    const badHost = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: srv.port,
          path: "/api/overlay",
          headers: { host: "evil.example", ...headers() },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(badHost).toBe(403);
  });
});

describe("overlay at view time", () => {
  it("carries an empty overlay when nothing is set, and the nodes are the view's own", async () => {
    await reset();
    const v = await view("?level=files");
    expect(v.overlay).toEqual({ hidden: 0, groups: [] });
    expect(v.nodes.some((n) => n.labelOriginal !== undefined)).toBe(false);
    expect(v.nodes.some((n) => n.path === INTERNAL)).toBe(true);
  });

  it("applies a label, a hidden glob and a group", async () => {
    await reset();
    const plain = await view("?level=files");
    const original = plain.nodes.find((n) => n.id === WEB_SLUG) as GraphNode;
    await send("PUT", "/api/overlay/labels", { nodeId: WEB_SLUG, text: "Web slug helper" });
    await send("PUT", "/api/overlay/hidden", { selectors: [{ type: "glob", glob: INTERNAL }] });
    await send("PUT", "/api/overlay/groups/dates", {
      name: "Dates",
      selectors: [{ type: "glob", glob: "packages/utils/src/{date,time}.ts" }],
      mayUse: null,
    });
    await send("PUT", "/api/overlay/groups/everything", {
      name: "All",
      selectors: [{ type: "kind", kind: "file" }],
    });
    const v = await view("?level=files");
    const labelled = v.nodes.find((n) => n.id === WEB_SLUG) as GraphNode;
    expect(labelled.label).toBe("Web slug helper");
    expect(labelled.labelOriginal).toBe(original.label);
    expect(v.nodes.some((n) => n.path === INTERNAL)).toBe(false);
    expect(v.overlay.hidden).toBe(1);
    expect(v.overlay.groups.map((g) => g.id)).toEqual(["dates", "everything"]);
    const dates = v.overlay.groups[0];
    expect(dates?.members).toEqual(
      v.nodes
        .filter((n) => /utils\/src\/(date|time)\.ts$/.test(n.path ?? ""))
        .map((n) => n.id)
        .sort(),
    );
    expect(dates?.members).toHaveLength(2);
    // Every edge that remains has both ends in the response.
    const ids = new Set(v.nodes.map((n) => n.id));
    expect(v.edges.every((e) => ids.has(e.src) && ids.has(e.dst))).toBe(true);
    expect(plain.edges.length).toBeGreaterThan(0);
  });

  it("hiding a workspace removes its descendants and their edges", async () => {
    await reset();
    const plain = await view("?level=files");
    const ui = plain.nodes.find((n) => n.kind === "workspace" && n.path === "packages/ui") as GraphNode;
    await send("PUT", "/api/overlay/hidden", { selectors: [{ type: "ids", ids: [ui.id] }] });
    const v = await view("?level=files");
    expect(v.nodes.some((n) => n.id === ui.id || n.path?.startsWith("packages/ui/"))).toBe(false);
    expect(v.overlay.hidden).toBe(plain.nodes.length - v.nodes.length);
    expect(v.overlay.hidden).toBeGreaterThan(1);
    expect(v.edges.length).toBeLessThan(plain.edges.length);
  });

  it("applies to every view, not only the project map", async () => {
    await reset();
    const r = await fetch(url("/api/view/debug"), { headers: headers() });
    expect(((await r.json()) as Overlayed).overlay).toEqual({ hidden: 0, groups: [] });
  });
});

describe("saved views", () => {
  const spec = {
    view: "project-map",
    level: "files",
    hidden: [],
    groups: ["dates"],
    filters: {},
  };
  async function setup(): Promise<void> {
    await reset();
    await send("PUT", "/api/overlay/groups/dates", {
      name: "Dates",
      selectors: [{ type: "glob", glob: "packages/utils/src/{date,time}.ts" }],
    });
    await send("PUT", "/api/overlay/groups/other", {
      name: "Other",
      selectors: [{ type: "kind", kind: "workspace" }],
    });
    await send("PUT", "/api/overlay/views/curated", { name: "Curated", spec });
  }

  it("applies the saved spec, and two identical requests return identical bytes", async () => {
    await setup();
    const get = async () =>
      (await fetch(url("/api/view/project-map?saved=curated"), { headers: headers() })).text();
    const [a, b] = [await get(), await get()];
    expect(a).toBe(b);
    const v = JSON.parse(a) as Overlayed;
    expect(v.overlay.groups.map((g) => g.id)).toEqual(["dates"]);
    expect(v.nodes.every((n) => n.kind !== "function")).toBe(true);
  });

  it("uses the spec's hidden list on top of the global one", async () => {
    await setup();
    await send("PUT", "/api/overlay/views/nodate", {
      name: "No dates",
      spec: { ...spec, hidden: [{ type: "glob", glob: "packages/utils/src/date.ts" }], groups: [] },
    });
    const v = await view("?saved=nodate");
    expect(v.nodes.some((n) => n.path === "packages/utils/src/date.ts")).toBe(false);
    expect(v.overlay.groups.map((g) => g.id)).toEqual(["dates", "other"]);
    const plain = await view("?level=files");
    expect(plain.nodes.some((n) => n.path === "packages/utils/src/date.ts")).toBe(true);
  });

  it("explicit query parameters override the saved spec", async () => {
    await setup();
    const saved = await view("?saved=curated");
    const overridden = await view("?saved=curated&level=symbols");
    expect(overridden.nodes.length).toBeGreaterThan(saved.nodes.length);
    expect(overridden.nodes.some((n) => n.kind === "function")).toBe(true);
    const defaults = await view("?level=files");
    expect(saved.nodes.map((n) => n.id)).toEqual(defaults.nodes.map((n) => n.id));
  });

  it("404 for an unknown saved view and 400 for one made for another view", async () => {
    await setup();
    const unknown = await fetch(url("/api/view/project-map?saved=nope"), { headers: headers() });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "Unknown saved view: nope" });
    const wrong = await fetch(url("/api/view/debug?saved=curated"), { headers: headers() });
    expect(wrong.status).toBe(400);
  });

  it("a new server on the same store reads the same overlay (it lives in the store, not the server)", async () => {
    await setup();
    const before = await (await fetch(url("/api/overlay"), { headers: headers() })).text();
    await srv.close();
    srv = await startExplorerServer({
      paths: paths(),
      store,
      config: {} as GantryConfig,
      writeStateFile: false,
    });
    expect(await (await fetch(url("/api/overlay"), { headers: headers() })).text()).toBe(before);
  });
});

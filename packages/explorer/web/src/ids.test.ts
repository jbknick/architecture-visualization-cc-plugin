import { describe, expect, it } from "vitest";
import * as core from "../../../core/src/ids.ts";
import * as web from "./ids.ts";

describe("web ids", () => {
  it("are the core id functions and agree on every kind", () => {
    expect(Object.keys(web).sort()).toEqual(Object.keys(core).sort());
    const ids = [
      core.fileId("acme/shop", "src/a#b.ts"),
      core.symId("acme/shop", "src/a.ts", "C.m~2"),
      core.routeId("acme/shop", "@a/web", "/posts/$postId"),
      core.endpointId("acme/shop", "@a/api", "rpc posts.list"),
      core.middlewareId("acme/shop", "@a/api", "/* cors"),
      core.callId("acme/shop", "@a/web", "GET /x"),
      core.tableId("acme/shop", "posts"),
    ];
    for (const id of ids) {
      expect(web.parseId(id)).toEqual(core.parseId(id));
      expect(web.displayOfId(id)).toBe(core.displayOfId(id));
    }
  });
});

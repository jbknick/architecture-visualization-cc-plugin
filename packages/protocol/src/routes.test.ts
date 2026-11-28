import { afterEach, describe, expect, it } from "vitest";
import { FIELD_SINCE, HEADER_PROTOCOL, PROTOCOL_VERSION, ROUTES, supports } from "./index.js";

describe("supports", () => {
  const shipped = { ...FIELD_SINCE };
  afterEach(() => {
    for (const key of Object.keys(FIELD_SINCE)) delete FIELD_SINCE[key];
    Object.assign(FIELD_SINCE, shipped);
  });

  it("is at version 2 and lists the lookup route as introduced by it", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(HEADER_PROTOCOL).toBe("X-Gantry-Protocol");
    expect(FIELD_SINCE).toEqual({ "POST /v1/descriptions/lookup": 2 });
    expect(supports(1, "POST /v1/descriptions/lookup")).toBe(false);
    expect(supports(undefined, "POST /v1/descriptions/lookup")).toBe(false);
    expect(supports(2, "POST /v1/descriptions/lookup")).toBe(true);
  });

  it("is true for a key that is not in FIELD_SINCE and for an unknown server maximum", () => {
    expect(supports(1, "anything")).toBe(true);
    expect(supports(undefined, "anything")).toBe(true);
  });

  it("is true only when the server maximum is at least the version of the key", () => {
    FIELD_SINCE["new.field"] = 3;
    expect(supports(undefined, "new.field")).toBe(false);
    expect(supports(1, "new.field")).toBe(false);
    expect(supports(2, "new.field")).toBe(false);
    expect(supports(3, "new.field")).toBe(true);
    expect(supports(4, "new.field")).toBe(true);
    expect(supports(2, "other")).toBe(true);
  });
});

describe("ROUTES", () => {
  it("lists the twelve routes with their methods and auth", () => {
    const table = Object.values(ROUTES).map((r) => `${r.method} ${r.path} ${r.auth.join("|")}`);
    expect(table).toEqual([
      "GET /v1/whoami ci|user",
      "POST /v1/repos/:repo/uploads ci",
      "PUT /v1/uploads/:id/parts/:n ci",
      "GET /v1/uploads/:id ci",
      "POST /v1/repos/:repo/change-sets/:id/close ci",
      "GET /v1/pull ci|user",
      "POST /v1/descriptions user",
      "POST /v1/descriptions/lookup user",
      "PUT /v1/repos/:repo/groups/:id user",
      "DELETE /v1/repos/:repo/groups/:id user",
      "PUT /v1/repos/:repo/views/:id user",
      "DELETE /v1/repos/:repo/views/:id user",
    ]);
  });

  it("the part route can answer conflict and budget", () => {
    expect(ROUTES.putPart.errors).toContain("conflict");
    expect(ROUTES.putPart.errors).toContain("budget");
    expect(ROUTES.putPart.errors).toContain("too_large");
  });

  it("the group and view save routes can answer conflict and too_large", () => {
    for (const route of [ROUTES.putGroup, ROUTES.putView]) {
      expect(route.errors).toContain("conflict");
      expect(route.errors).toContain("too_large");
    }
  });
});

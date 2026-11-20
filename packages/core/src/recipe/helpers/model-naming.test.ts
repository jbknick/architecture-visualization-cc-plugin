import { describe, expect, it } from "vitest";
import { normalizeModel, pluralize, snakeCase, tableCandidates } from "./model-naming.js";

describe("model-naming", () => {
  it("converts to snake_case and plural", () => {
    expect(snakeCase("UserAccount")).toBe("user_account");
    expect(snakeCase("HTTPServer")).toBe("http_server");
    expect(pluralize("user")).toBe("users");
    expect(pluralize("category")).toBe("categories");
    expect(pluralize("box")).toBe("boxes");
    expect(pluralize("day")).toBe("days");
  });

  it("lists the model itself when the recipe states nothing", () => {
    expect(tableCandidates("Post", undefined)).toEqual(["Post"]);
  });

  it("puts the explicit entry first (a schema's mapped name)", () => {
    expect(tableCandidates("User", { explicit: { User: "users" } })).toEqual(["users", "User"]);
  });

  it("derives snake_case (a query builder that names tables by camelCase keys)", () => {
    expect(tableCandidates("userProviders", { snakeCase: true })).toEqual([
      "userProviders",
      "user_providers",
    ]);
  });

  it("derives plural, and snake_case plus plural (a struct or entity named in the singular)", () => {
    expect(tableCandidates("Group", { plural: true })).toEqual(["Group", "Groups"]);
    expect(tableCandidates("UserAccount", { snakeCase: true, plural: true })).toEqual([
      "UserAccount",
      "user_account",
      "UserAccounts",
      "user_accounts",
    ]);
  });

  it("compares model names without case or punctuation", () => {
    expect(normalizeModel("UserAccount")).toBe(normalizeModel("user_account"));
  });
});

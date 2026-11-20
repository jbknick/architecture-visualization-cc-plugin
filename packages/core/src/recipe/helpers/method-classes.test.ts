import { describe, expect, it } from "vitest";
import { classifyMethod } from "./method-classes.js";

describe("method-classes", () => {
  const classes = {
    read: ["find", "findOne", "findOneAndUpdate", "count"],
    write: ["save", "update", "findOneAndUpdate", "deleteMany"],
  };

  it("classes a method by the lists the recipe states", () => {
    expect(classifyMethod("findOne", classes)).toBe("read");
    expect(classifyMethod("deleteMany", classes)).toBe("write");
  });

  it("classes a method in both lists as a write (it changes the row and returns it)", () => {
    expect(classifyMethod("findOneAndUpdate", classes)).toBe("write");
  });

  it("gives no class to a method in neither list, or when the recipe has no lists", () => {
    expect(classifyMethod("flush", classes)).toBeNull();
    expect(classifyMethod("find", undefined)).toBeNull();
    expect(classifyMethod("find", { write: ["save"] })).toBeNull();
  });
});

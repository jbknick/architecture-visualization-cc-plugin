import { expect, test } from "vitest";
import { name } from "./index.js";

test("placeholder export", () => {
  expect(name).toBe("@gantry/explorer");
});

import { expect, it } from "vitest";
import type { FileRecord } from "../types.js";
import { DEFAULT_GROUP_GLOBS, defaultGroups } from "./defaults.js";
import { GroupIdSchema, GroupSchema } from "./types.js";

const file = (path: string): FileRecord => ({
  id: `file:t:${path}`,
  path,
  lang: "typescript",
  workspaceId: null,
  contentHash: "h",
  mtimeMs: 0,
  deleted: false,
});

it("keeps the globs the feature slices view used to read from the config", () => {
  expect(DEFAULT_GROUP_GLOBS).toEqual(["apps/*/src/features/*", "apps/*/src/modules/*", "packages/*"]);
});

it("makes one group per matching directory that holds a file, sorted by id", () => {
  const groups = defaultGroups([
    file("packages/utils/src/slug.ts"),
    file("packages/utils/src/date.ts"),
    file("apps/web/src/features/posts/list.ts"),
    file("apps/web/src/modules/auth/login.ts"),
    file("apps/web/src/routes/index.tsx"),
    file("scripts/build.ts"),
    file("packages/ui/src/button.tsx"),
  ]);
  expect(groups.map((g) => g.id)).toEqual([
    "default:apps/web/src/features/posts",
    "default:apps/web/src/modules/auth",
    "default:packages/ui",
    "default:packages/utils",
  ]);
  expect(groups.find((g) => g.id === "default:packages/ui")).toEqual({
    id: "default:packages/ui",
    name: "packages/ui",
    selectors: [{ type: "glob", glob: "packages/ui/**" }],
    mayUse: null,
  });
  expect(groups.every((g) => g.mayUse === null)).toBe(true);
});

it("makes no group for an empty index or a directory without files", () => {
  expect(defaultGroups([])).toEqual([]);
  expect(defaultGroups([file("packages/index.ts")])).toEqual([]);
});

it("uses ids a person cannot write", () => {
  const [g] = defaultGroups([file("packages/ui/a.ts")]);
  expect(GroupIdSchema.safeParse(g?.id).success).toBe(false);
  expect(GroupSchema.safeParse(g).success).toBe(false);
});

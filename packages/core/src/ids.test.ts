import { describe, expect, it } from "vitest";
import {
  callId,
  displayOfId,
  endpointId,
  fileId,
  fileIdBeside,
  fileIdOfSymId,
  middlewareId,
  nameOfSymId,
  parseId,
  pathOfFileId,
  pathOfId,
  pathOfSymId,
  qualifyId,
  repoOfId,
  routeId,
  symId,
  symIdOfFileId,
  tableId,
} from "./ids.js";

const REPOS = ["repo", "acme/shop", "a.b-c_d"];
const PATHS = ["src/a.ts", "src/with space/a b.ts", "src/c#d.ts", "src/e:f.ts", "weird/#:/x.tsx"];
const NAMES = ["foo", "Class.method", "default", "foo~2", "Class.method~3", "~2"];

describe("ids", () => {
  it("round-trips file ids", () => {
    for (const repo of REPOS)
      for (const path of PATHS) {
        const id = fileId(repo, path);
        expect(id).toBe(`file:${repo}:${path}`);
        expect(parseId(id)).toEqual({ kind: "file", repo, path, rest: path });
        expect(pathOfFileId(id)).toBe(path);
        expect(pathOfId(id)).toBe(path);
        expect(repoOfId(id)).toBe(repo);
      }
  });

  it("round-trips symbol ids, including `#`, `:`, spaces and `~2`", () => {
    for (const repo of REPOS)
      for (const path of PATHS)
        for (const name of NAMES) {
          const id = symId(repo, path, name);
          expect(id).toBe(`sym:${repo}:${path}#${name}`);
          expect(parseId(id)).toMatchObject({ kind: "sym", repo, path, name });
          expect(pathOfSymId(id)).toBe(path);
          expect(nameOfSymId(id)).toBe(name);
          expect(fileIdOfSymId(id)).toBe(fileId(repo, path));
          expect(symIdOfFileId(fileId(repo, path), name)).toBe(id);
          expect(displayOfId(id)).toBe(`${path}#${name}`);
        }
  });

  it("round-trips route, endpoint, middleware and call ids", () => {
    const cases: [string, (repo: string, ws: string, rest: string) => string][] = [
      ["route", routeId],
      ["ep", endpointId],
      ["mw", middlewareId],
      ["call", callId],
    ];
    for (const repo of REPOS)
      for (const ws of ["@acme/web", "."])
        for (const rest of ["/posts/$postId", "GET /api/x:y", "rpc posts.list", "/_app/settings/"])
          for (const [kind, make] of cases) {
            const id = make(repo, ws, rest);
            expect(id).toBe(`${kind}:${repo}:${ws}:${rest}`);
            expect(parseId(id)).toEqual({ kind, repo, ws, rest });
          }
  });

  it("round-trips table ids", () => {
    for (const repo of REPOS) {
      const id = tableId(repo, "posts~2");
      expect(id).toBe(`table:${repo}:posts~2`);
      expect(parseId(id)).toEqual({ kind: "table", repo, name: "posts~2", rest: "posts~2" });
    }
  });

  it("does not parse a workspace id, an external id or a malformed id", () => {
    for (const id of [
      "ws:@acme/ui",
      "ws:.",
      "ext:react",
      "dir:src",
      "file:",
      "sym:repo:no-hash",
      "plain/path.ts",
    ])
      expect(parseId(id)).toBeUndefined();
    expect(pathOfFileId("src/a.ts")).toBe("src/a.ts");
    expect(pathOfSymId("file:repo:a.ts")).toBeUndefined();
  });

  it("qualifies the short forms a person types", () => {
    expect(qualifyId("r", "route:@a/web:/posts")).toBe("route:r:@a/web:/posts");
    expect(qualifyId("r", "table:posts")).toBe("table:r:posts");
    expect(qualifyId("r", "file:src/a.ts")).toBe("file:r:src/a.ts");
    expect(qualifyId("r", "src/a.ts")).toBeUndefined();
    expect(fileIdBeside("sym:r:x.ts#a", "src/b.ts")).toBe("file:r:src/b.ts");
  });
});

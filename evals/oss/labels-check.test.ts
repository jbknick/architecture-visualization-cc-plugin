import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callText, checkLabels } from "../../scripts/eval-label-check.js";
import { candidates, listedSites, sample, staleListed, unlabelled } from "../../scripts/eval-label-scan.js";
import { labelsSchema, type Repo } from "../../scripts/eval-lib.js";

const SHA = "b".repeat(40);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function clone(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "gantry-labelscan-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const repo = (stack: string[]): Repo => ({
  name: "tiny",
  url: "https://example.com/tiny.git",
  sha: SHA,
  stack,
  lang: ["ts"],
  role: "held-out",
});
const labels = (over: Record<string, unknown>) =>
  labelsSchema.parse({ repo: "tiny", sha: SHA, labelledBy: "test", kinds: ["endpoint"], ...over });

const files = {
  "src/users.ts": [
    "const router = Router();",
    "router.get(",
    '  "/",',
    "  list,",
    ");",
    'router.post("/", create);',
    'router.delete("/:id", remove);',
    "export default router;",
  ].join("\n"),
  "src/users.test.ts": 'router.get("/ignored", x);',
  "node_modules/x/index.ts": 'router.get("/ignored", x);',
  "src/pages/index.ts": "export const a = 1;",
};

const label = (over: Record<string, unknown> = {}) => ({
  method: "GET",
  path: "/users",
  file: "src/users.ts",
  registration: "src/users.ts:2",
  ...over,
});

describe("candidates", () => {
  it("finds registration calls and skips tests and vendored code", () => {
    const found = candidates(clone(files), ["express"]).map((c) => `${c.file}:${c.line}`);
    expect(found).toEqual(["src/users.ts:2", "src/users.ts:6", "src/users.ts:7"]);
  });

  it("finds nothing for a stack it has no pattern for", () => {
    expect(candidates(clone(files), ["go"])).toEqual([]);
  });

  it("finds Nest decorators, server functions, procedures and file routes", () => {
    const dir = clone({
      "a.controller.ts": "@Controller('a')\nclass A {\n  @Get(':id')\n  one() {}\n}",
      "fns.ts": "export const getA = createServerFn({ method: 'GET' }).handler(() => 1)",
      "router.ts": "export default {\n  list: protectedProcedure({}),\n}",
      "routes/x.tsx": "export const Route = createFileRoute('/x')({})",
      "app/page.tsx": "export default function P() {}",
    });
    const kinds = candidates(dir, ["nestjs", "tanstack-start", "orpc", "nextjs"]).map(
      (c) => `${c.kind}:${c.file}:${c.line}:${c.name ?? ""}`,
    );
    expect(kinds).toEqual([
      "call:a.controller.ts:3:",
      "file:app/page.tsx:1:",
      "fn:fns.ts:1:getA",
      "rpc:router.ts:2:list",
      "file:routes/x.tsx:1:",
    ]);
  });
});

describe("unlabelled", () => {
  const dir = () => clone(files);
  it("reports a registration that no label covers, and a listed one is accepted", () => {
    const l = labels({ endpoint: [label(), label({ method: "POST", registration: "src/users.ts:6" })] });
    const miss = unlabelled(dir(), repo(["express"]), l, "");
    expect(miss.map((c) => c.line)).toEqual([7]);
    const readme =
      "- `tiny` `src/users.ts:7`: a delete on a store, not a route\n- `other` `src/users.ts:7`: x";
    expect(unlabelled(dir(), repo(["express"]), l, readme)).toEqual([]);
    expect([...listedSites(readme, "tiny").keys()]).toEqual(["src/users.ts:7"]);
  });

  it("accepts a registration on the second line of a chained call", () => {
    const l = labels({
      endpoint: [
        label({ registration: "src/users.ts:3" }),
        label({ method: "POST", registration: "src/users.ts:6" }),
      ],
    });
    expect(unlabelled(dir(), repo(["express"]), l, "").map((c) => c.line)).toEqual([7]);
  });

  it("finds a listed site the scan no longer finds", () => {
    expect(staleListed(dir(), repo(["express"]), "- `tiny` `src/users.ts:99`: gone")).toEqual([
      "src/users.ts:99",
    ]);
    expect(staleListed(dir(), repo(["express"]), "- `tiny` `src/users.ts:7`: there")).toEqual([]);
  });

  it("covers a React Router call by the route label that its text names", () => {
    const d = clone({ "src/App.tsx": "<Route path='/a/:id'>\n<Route path='/b'>\n<Route {...rest}>" });
    const l = labels({ kinds: ["route"], route: [{ path: "/a/:id", file: "src/App.tsx" }] });
    expect(unlabelled(d, repo(["react-router"]), l, "").map((c) => c.line)).toEqual([2, 3]);
  });
});

describe("checks of a TypeScript registration", () => {
  const dir = () => clone(files);
  it("holds the method anywhere in the call, and not the path segment", () => {
    expect(callText(files["src/users.ts"].split("\n"), 2)).toContain('"/"');
    const ok = labels({ endpoint: [label({ path: "/api/v1/users/:id" })] });
    expect(checkLabels(ok, dir())).toEqual([]);
  });

  it("flags a registration whose call lacks the method or lies in another file", () => {
    const wrong = labels({ endpoint: [label({ method: "PUT" })] });
    expect(checkLabels(wrong, dir())).toEqual(["endpoint PUT /users registration: line does not hold PUT"]);
    const other = labels({ endpoint: [label({ registration: "src/other.ts:1" })] });
    expect(checkLabels(other, dir())).toEqual([
      "endpoint GET /users registration: src/other.ts:1 is not in src/users.ts",
    ]);
  });

  it("accepts a prefix that only the folder holds, for a label without a registration", () => {
    const d = clone({ "src/routes/api/tasks/index.ts": "fastify.get('/', h)" });
    const l = labels({
      endpoint: [{ method: "GET", path: "/api/tasks/", file: "src/routes/api/tasks/index.ts" }],
    });
    expect(checkLabels(l, d)).toEqual([]);
  });
});

describe("sample", () => {
  it("lists every tenth label in id order with its registration line", () => {
    const eps = Array.from({ length: 12 }, (_, i) => ({
      method: "GET",
      path: `/r${String(i).padStart(2, "0")}`,
      file: "src/users.ts",
      registration: "src/users.ts:6",
    }));
    const out = sample(labels({ endpoint: eps }), clone(files), 10);
    expect(out.map((s) => s.id)).toEqual(["endpoint GET /r00", "endpoint GET /r10"]);
    expect(out[0]).toMatchObject({ file: "src/users.ts", line: 6, text: 'router.post("/", create);' });
  });

  it("finds the source line of a route or a procedure by its name", () => {
    const d = clone({ "r.ts": "import { x } from 'y';\nexport const Route = createFileRoute('/login')({})" });
    const out = sample(labels({ kinds: ["route"], route: [{ path: "/login", file: "r.ts" }] }), d, 10);
    expect(out).toEqual([
      {
        id: "route /login",
        file: "r.ts",
        line: 2,
        text: "export const Route = createFileRoute('/login')({})",
      },
    ]);
  });
});

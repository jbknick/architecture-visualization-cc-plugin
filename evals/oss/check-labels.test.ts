import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Dump } from "../../scripts/eval-lib.js";
import {
  checkLinking,
  hasCall,
  type LinkingLabels,
  linkingProblems,
  linkingSchema,
  MIN_LINKABLE,
  scoreLinking,
} from "../../scripts/eval-linking.js";

const SHA = "a".repeat(40);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function clone(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "gantry-checklabels-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const expect1 = { repo: "app", workspace: "app", method: "GET", path: "/api/x" };
const site = (line: number, over: Record<string, unknown> = {}) => ({
  repo: "app",
  file: "web/api.ts",
  line,
  method: "GET",
  path: "/api/x",
  expect: expect1,
  ...over,
});
const labelsOf = (requests: unknown[]): LinkingLabels =>
  linkingSchema.parse({
    case: "linking-t",
    repos: [{ name: "app", sha: SHA }],
    labelledBy: "test",
    requests,
  });

/** MIN_LINKABLE call lines, so the count check is met. */
const manyCalls = Array.from({ length: MIN_LINKABLE }, (_, i) => `  await get("/api/x${i}");`).join("\n");
const manySites = Array.from({ length: MIN_LINKABLE }, (_, i) => site(i + 1, { path: `/api/x${i}` }));

describe("check-labels", () => {
  it("accepts labels whose lines hold a call", () => {
    const dir = clone({ "web/api.ts": manyCalls });
    expect(checkLinking(labelsOf(manySites), () => dir)).toEqual([]);
  });

  it("reports a missing file, a line past the end and a line without a call", () => {
    const dir = clone({ "web/api.ts": `${manyCalls}\nconst x = 1;` });
    const bad = [
      ...manySites,
      site(MIN_LINKABLE + 1, { path: "/api/no-call" }),
      site(99, { path: "/api/past" }),
      site(1, { file: "web/gone.ts", path: "/api/gone" }),
    ];
    const problems = checkLinking(labelsOf(bad), () => dir);
    expect(problems).toEqual([
      `app:web/api.ts:${MIN_LINKABLE + 1}: line holds no call`,
      expect.stringContaining("app:web/api.ts:99: line is past the end"),
      "app:web/gone.ts:1: file does not exist",
    ]);
  });

  it("needs at least 20 linkable labels; null labels do not count", () => {
    const dir = clone({ "web/api.ts": manyCalls });
    const few = manySites.slice(0, MIN_LINKABLE - 1);
    const nulls = manySites.slice(MIN_LINKABLE - 1).map((s) => ({ ...s, expect: null, reason: "dynamic" }));
    const problems = checkLinking(labelsOf([...few, ...nulls]), () => dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/only 19 linkable labels/);
  });

  it("sees a call in common request forms", () => {
    for (const line of [
      "const r = await axios.get(`/a/${id}`);",
      "return API.get<Articles>(`/articles`);",
      "fetch(url)",
      "  .then(() => foo())",
      "postAPI('x', y)",
    ])
      expect(hasCall(line), line).toBe(true);
    for (const line of ["const x = 1;", "// axios", "import axios from 'axios'", "export default api;"])
      expect(hasCall(line), line).toBe(false);
  });
});

describe("linking label schema", () => {
  const repos = [
    {
      name: "app",
      url: "https://example.test/app.git",
      sha: SHA,
      stack: ["express"],
      lang: ["ts" as const],
      role: "tuning" as const,
    },
  ];

  it("requires a reason exactly when expect is null", () => {
    const problems = linkingProblems(
      labelsOf([
        site(1, { expect: null }),
        site(2, { reason: "dynamic" }),
        site(3, { expect: null, reason: "external" }),
      ]),
      repos,
    );
    expect(problems).toEqual([
      "app:web/api.ts:1: a null expect needs a reason",
      "app:web/api.ts:2: a reason belongs only to a null expect",
    ]);
  });

  it("rejects a sha that differs from repos.json, an unknown repo and a duplicate", () => {
    const labels = linkingSchema.parse({
      case: "linking-t",
      repos: [
        { name: "app", sha: "b".repeat(40) },
        { name: "other", sha: SHA },
      ],
      labelledBy: "test",
      requests: [site(1), site(1)],
    });
    const problems = linkingProblems(labels, repos);
    expect(problems).toContain(`repo app: sha ${"b".repeat(40)} differs from repos.json ${SHA}`);
    expect(problems).toContain("repo other is not in repos.json");
    expect(problems).toContain("app:web/api.ts:1: duplicate label GET /api/x");
  });

  it("rejects unknown keys and bad methods", () => {
    expect(() => labelsOf([site(1, { extra: 1 })])).toThrow();
    expect(() => labelsOf([site(1, { method: "get" })])).toThrow();
  });
});

describe("scoreLinking", () => {
  const dump = (confidence: string, evidence: string[], path = "/api/x"): Dump => ({
    files: [{ id: "f1", path: "web/api.ts" }],
    edges: [{ src: "s", dst: "ep1", kind: "requests", confidence, fileId: "f1", evidence }],
    adapterNodes: [{ id: "ep1", kind: "endpoint", data: { method: "GET", path } }],
  });
  const labels = labelsOf([site(5), site(6, { expect: null, reason: "external" })]);

  it("counts a link at the labelled file and line as matched", () => {
    const s = scoreLinking(labels, { app: dump("high", ["web/api.ts:5"]) });
    expect(s.requests).toMatchObject({ labelled: 1, predicted: 1, matched: 1, recall: 1, wrongHigh: 0 });
  });

  it("counts a high link at a null site or the wrong endpoint as wrongHigh", () => {
    expect(scoreLinking(labels, { app: dump("high", ["web/api.ts:6"]) }).requests.wrongHigh).toBe(1);
    expect(scoreLinking(labels, { app: dump("high", ["web/api.ts:5"], "/api/y") }).requests).toMatchObject({
      matched: 0,
      wrongHigh: 1,
      recall: 0,
    });
    expect(scoreLinking(labels, { app: dump("low", ["web/api.ts:6"]) }).requests.wrongHigh).toBe(0);
  });

  it("has recall 0 and passes nothing when no link is predicted", () => {
    const empty: Dump = { files: [], edges: [], adapterNodes: [] };
    const s = scoreLinking(labels, { app: empty });
    expect(s.requests).toMatchObject({ labelled: 1, predicted: 0, precision: 1, recall: 0, wrongHigh: 0 });
    expect(s.pass).toBe(false);
  });
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "../indexer.js";
import { type GantryPaths, resolvePaths } from "../paths/index.js";
import { openStore, type Store } from "../store/index.js";
import { MAX_CONSUMERS } from "./consumers.js";
import { reviewDiff } from "./diff.js";
import { computeImpact, formatImpact, modifiedChanges, reviewImpact } from "./impact.js";

interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const fixtures: MaterializedFixture[] = [];
const dataDirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dataDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of fixtures.splice(0)) await f.cleanup();
});

function write(fx: MaterializedFixture, rel: string, text: string): void {
  const p = join(fx.dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
const read = (fx: MaterializedFixture, rel: string): string => readFileSync(join(fx.dir, rel), "utf8");
function commit(fx: MaterializedFixture, message: string): void {
  fx.git(["add", "-A"]);
  fx.git(["commit", "-m", message]);
}

async function setup(prepare?: (fx: MaterializedFixture) => void) {
  const fx = await materializeFixture("pnpm-turbo");
  fixtures.push(fx);
  if (prepare) {
    prepare(fx);
    commit(fx, "prepare");
  }
  const data = mkdtempSync(join(tmpdir(), "gantry-consumers-data-"));
  dataDirs.push(data);
  const paths: GantryPaths = resolvePaths(fx.dir, { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data });
  await indexRepo(paths, { layer: "main" });
  const store = openStore(paths.dbPath);
  stores.push(store);
  return { fx, paths, store };
}

const BUTTON = "sym:pnpm-turbo:packages/ui/src/button.tsx#Button";
const HOME = "sym:pnpm-turbo:apps/web/src/routes/index.tsx#HomePage";
const PROFILE = "sym:pnpm-turbo:apps/web/src/routes/settings/profile.tsx#ProfilePage";

describe("consumers of a review's changes (#169)", () => {
  it("a component rendered elsewhere lists its renderers directly and their route and importers as potential", async () => {
    const { fx, paths, store } = await setup();
    fx.git(["checkout", "-b", "feature"]);
    write(
      fx,
      "packages/ui/src/button.tsx",
      read(fx, "packages/ui/src/button.tsx").replace("{label}", "{label.trim()}"),
    );
    commit(fx, "button body");
    const diff = await reviewDiff(paths, "main", "feature");
    const impact = await reviewImpact(paths, store, diff);
    const sym = impact.consumers.find((c) => c.id === BUTTON);
    expect(sym?.target).toBe("symbol");
    // sorted by workspace, then path, then name
    expect(sym?.direct.map((d) => [d.workspace, d.id, d.uses, d.crosses])).toEqual([
      ["@acme/ui", "file:pnpm-turbo:packages/ui/src/index.ts", ["imports"], []],
      ["@acme/web", HOME, ["renders"], ["app"]],
      ["@acme/web", PROFILE, ["renders"], ["app"]],
    ]);
    expect(sym?.direct[1]).toMatchObject({ name: "HomePage", kind: "component", line: 7, hop: 1 });
    expect(sym?.directTotal).toBe(3);
    const route = sym?.potential.find((p) => p.id === "route:pnpm-turbo:@acme/web:/");
    expect(route).toMatchObject({ hop: 2, via: HOME, next: HOME, uses: ["serves"], kind: "route" });
    // profile.tsx imports the barrel: reached through the barrel at hop 2
    expect(
      sym?.potential.find((p) => p.id === "file:pnpm-turbo:apps/web/src/routes/settings/profile.tsx"),
    ).toMatchObject({
      hop: 2,
      via: "file:pnpm-turbo:packages/ui/src/index.ts",
      uses: ["imports"],
    });
    expect(sym?.potentialTotal).toBe(sym?.potential.length);
    // no potential consumer repeats a direct one or the change itself
    const direct = new Set(sym?.direct.map((d) => d.id));
    expect(sym?.potential.some((p) => direct.has(p.id) || p.id === BUTTON)).toBe(false);

    // the changed file: the files that import it
    const file = impact.consumers.find((c) => c.id === "file:pnpm-turbo:packages/ui/src/button.tsx");
    expect(file?.target).toBe("file");
    expect(file?.direct.map((d) => d.id)).toEqual([
      "file:pnpm-turbo:packages/ui/src/index.ts",
      "file:pnpm-turbo:apps/web/src/routes/index.tsx",
      "file:pnpm-turbo:apps/web/src/routes/settings/profile.tsx",
    ]);
    expect(
      file?.direct.every((d) => d.uses.join() === "imports" && d.kind === "file" && d.line === null),
    ).toBe(true);

    const text = formatImpact(diff, impact);
    expect(text).toContain(`Consumers of ${BUTTON}:`);
    expect(text).toContain("Directly affected (3):");
    expect(text).toContain("HomePage (component, apps/web/src/routes/index.tsx:7) renders; crosses app");
    expect(text).toContain("Potentially affected (");
  });

  it("a type used by another file lists the code that references it", async () => {
    const { fx, paths, store } = await setup((f) => {
      write(f, "packages/ui/src/size.ts", "export type Size = number;\n");
      write(
        f,
        "packages/ui/src/sized.ts",
        'import type { Size } from "./size";\nexport function sized(s: Size): number {\n  return s;\n}\n',
      );
    });
    fx.git(["checkout", "-b", "feature"]);
    write(fx, "packages/ui/src/size.ts", "export type Size = number | string;\n");
    commit(fx, "size");
    const impact = await reviewImpact(paths, store, await reviewDiff(paths, "main", "feature"));
    const size = impact.consumers.find((c) => c.id === "sym:pnpm-turbo:packages/ui/src/size.ts#Size");
    expect(size?.direct.map((d) => [d.id, d.uses])).toEqual([
      ["sym:pnpm-turbo:packages/ui/src/sized.ts#sized", ["references_type"]],
    ]);
    // the walk and the risk follow references_type at hop 1 too
    expect(impact.callersByHop[0]?.ids).toEqual(["sym:pnpm-turbo:packages/ui/src/sized.ts#sized"]);
  });

  it("caps each tier at MAX_CONSUMERS and reports the total", async () => {
    const n = MAX_CONSUMERS + 5;
    const { store } = await setup((f) => {
      for (let i = 0; i < n; i++) {
        const name = `f${String(i).padStart(3, "0")}`;
        write(
          f,
          `apps/web/src/gen/${name}.ts`,
          `import { slugify } from "../lib/slug";\nexport function ${name}(): string {\n  return slugify("x");\n}\n`,
        );
      }
    });
    const impact = computeImpact(
      store,
      modifiedChanges(store, ["sym:pnpm-turbo:apps/web/src/lib/slug.ts#slugify"]),
    );
    const c = impact.consumers[0];
    expect(c?.directTotal).toBe(n + 1); // the generated callers and PostList
    expect(c?.direct).toHaveLength(MAX_CONSUMERS);
    const paths = c?.direct.map((d) => d.path) ?? [];
    expect([...paths].sort()).toEqual(paths);
    expect(c?.direct[0]?.id).toBe("sym:pnpm-turbo:apps/web/src/components/PostList.tsx#PostList");
  }, 60_000);
});

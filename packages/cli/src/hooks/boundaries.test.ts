import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fileId,
  type Group,
  indexRepo,
  openStore,
  resolvePaths,
  type Store,
  type SymbolRecord,
  saveGroup,
} from "@gantry/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crossingFindings } from "./boundaries.js";
import { runHook } from "./entry.js";
import { settleBatch } from "./postToolUse.js";

interface MaterializedFixture {
  dir: string;
  git: (args: string[]) => string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/fixture.js";
const { materializeFixture, materializeFiles } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
  materializeFiles: (files: Record<string, string>, repo?: string) => Promise<MaterializedFixture>;
};

const EDIT = readFileSync(
  fileURLToPath(new URL("../../../../fixtures/overlay-groups/invoice.edited.txt", import.meta.url)),
  "utf8",
);
const LINE =
  "Gantry: totalDue (src/orders/invoice.ts:3) in group Orders uses formatPrice (src/catalog/price.ts:1) in group Catalog, which Orders does not list. Warn only.";
const STOP = (text: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: text } });

const ORDERS: Group = {
  id: "orders",
  name: "Orders",
  selectors: [{ type: "glob", glob: "src/orders/**" }],
  mayUse: [],
};
const CATALOG: Group = {
  id: "catalog",
  name: "Catalog",
  selectors: [{ type: "glob", glob: "src/catalog/**" }],
  mayUse: ["orders"],
};

let fx: MaterializedFixture;
let data: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "gantry-boundaries-"));
  env = { ...process.env, HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data };
});
afterEach(async () => {
  rmSync(data, { recursive: true, force: true });
  await fx?.cleanup();
});

/** Indexes the repo (main layer) and saves the groups. */
async function setup(name: "overlay-groups" | "files", groups: Group[], files?: Record<string, string>) {
  fx = name === "files" ? await materializeFiles(files ?? {}) : await materializeFixture(name);
  const paths = resolvePaths(fx.dir, env);
  await indexRepo(paths, { layer: "main" });
  const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: paths.repo });
  for (const g of groups) saveGroup(store, g);
  store.close();
  return paths;
}

const hash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const edit = async (rel: string, text: string, session = "s1") => {
  writeFileSync(join(fx.dir, rel), text);
  return runHook(
    "post-tool-use",
    [],
    fx.dir,
    env,
    () => undefined,
    JSON.stringify({
      session_id: session,
      cwd: fx.dir,
      tool_name: "Write",
      tool_input: { file_path: join(fx.dir, rel) },
    }),
  );
};
const stop = (session = "s1") =>
  runHook("stop", [], fx.dir, env, () => undefined, JSON.stringify({ session_id: session, cwd: fx.dir }));

describe("group boundary warnings", () => {
  it("warns at Stop once and at pre-commit, and no hook writes overlay.db", async () => {
    const paths = await setup("overlay-groups", [ORDERS, CATALOG]);
    const before = hash(paths.overlayPath);
    expect(await edit("src/orders/invoice.ts", EDIT)).toBeUndefined();
    expect(await stop()).toBe(STOP(LINE));
    expect(await stop()).toBeUndefined();

    fx.git(["add", "src/orders/invoice.ts"]);
    const err: string[] = [];
    await runHook("pre-commit", [], fx.dir, env, (s) => void err.push(s));
    expect(err.join("")).toBe(`${LINE}\n`);

    // Every other hook that heals or reads the store leaves the overlay alone too.
    for (const h of ["session-start", "post-checkout", "post-merge", "post-rewrite", "pre-push"]) {
      await runHook(h, [], fx.dir, env, () => undefined);
    }
    expect(hash(paths.overlayPath)).toBe(before);
  });

  it("a group with mayUse null is not a boundary", async () => {
    await setup("overlay-groups", [{ ...ORDERS, mayUse: null }, CATALOG]);
    await edit("src/orders/invoice.ts", EDIT);
    expect(await stop()).toBeUndefined();
    fx.git(["add", "src/orders/invoice.ts"]);
    const err: string[] = [];
    await runHook("pre-commit", [], fx.dir, env, (s) => void err.push(s));
    expect(err.join("")).toBe("");
  });

  it("an allowed edge never prints", async () => {
    await setup("overlay-groups", [ORDERS, CATALOG]);
    const cart = `import { totalDue } from "../orders/invoice";

export function cartTotal(items: number[]): number {
  return totalDue(items);
}

export function cartTotalTwice(items: number[]): number {
  return totalDue(items) * 2;
}
`;
    await edit("src/catalog/cart.ts", cart);
    expect(await stop()).toBeUndefined();
  });

  it("an edge the main layer already had never prints", async () => {
    await setup("overlay-groups", [ORDERS, { ...CATALOG, mayUse: [] }]);
    // cart.ts already imports and calls totalDue in the indexed commit; a new function elsewhere in it changes nothing.
    const cart = readFileSync(join(fx.dir, "src/catalog/cart.ts"), "utf8");
    await edit("src/catalog/cart.ts", `${cart}\nexport const two = 2;\n`);
    expect(await stop()).toBeUndefined();
  });

  it("an import with no call prints the file-level line", async () => {
    await setup("overlay-groups", [ORDERS, CATALOG]);
    await edit(
      "src/orders/invoice.ts",
      `import { formatPrice } from "../catalog/price";

export const label = formatPrice;
${readFileSync(join(fx.dir, "src/orders/invoice.ts"), "utf8")}`,
    );
    const out = await stop();
    expect(out).toBe(
      STOP(
        "Gantry: src/orders/invoice.ts in group Orders imports src/catalog/price.ts in group Catalog, which Orders does not list. Warn only.",
      ),
    );
  });

  it("the double-check drops a crossing whose import is gone from disk", async () => {
    await setup("overlay-groups", [ORDERS, CATALOG]);
    await edit("src/orders/invoice.ts", EDIT);
    // A shell command removes the import without a hook running.
    writeFileSync(
      join(fx.dir, "src/orders/invoice.ts"),
      "export function totalDue(items: number[]): string {\n  return String(items.length);\n}\n",
    );
    expect(await stop()).toBeUndefined();
  });

  it("30 boundary groups and a 20-file batch share the cap and the budget margin", async () => {
    const files: Record<string, string> = { "package.json": '{ "name": "@demo/many", "private": true }\n' };
    for (let i = 0; i <= 20; i++)
      files[`src/g${i}/f.ts`] = `export function v${i}(): number {\n  return ${i};\n}\n`;
    const groups: Group[] = Array.from({ length: 30 }, (_, i) => ({
      id: `g${i}`,
      name: `G${i}`,
      selectors: [{ type: "glob", glob: `src/g${i}/**` }],
      mayUse: [],
    }));
    await setup("files", groups, files);
    for (let i = 0; i < 20; i++) {
      await edit(
        `src/g${i}/f.ts`,
        `import { v${i + 1} } from "../g${i + 1}/f";\n\nexport function v${i}(): number {\n  return v${i + 1}();\n}\n`,
        "many",
      );
    }
    // No file is started after the deadline: nothing printed, the whole batch stays.
    expect(
      await settleBatch(resolvePaths(fx.dir, env), { sessionId: "many" }, { deadline: Date.now() - 1 }),
    ).toBe(undefined);
    const out = await stop("many");
    const text = (JSON.parse(out ?? "{}") as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext;
    expect(text).toBeDefined();
    expect((text ?? "").length).toBeLessThanOrEqual(600);
    const lines = (text ?? "").split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toBe(
      "Gantry: v0 (src/g0/f.ts:3) in group G0 uses v1 (src/g1/f.ts:3) in group G1, which G0 does not list. Warn only.",
    );
    for (const l of lines) expect(l).toMatch(/^Gantry: .* Warn only\.$/);
  });
});

describe("crossingFindings options", () => {
  /** The functions of `rel` as the hook sees them after the edit, with the store open for the callback. */
  async function withChanged<T>(rel: string, body: (store: Store, changed: SymbolRecord[]) => T): Promise<T> {
    const paths = resolvePaths(fx.dir, env);
    const store = openStore(paths.dbPath, { overlayPath: paths.overlayPath, repo: paths.repo });
    try {
      return body(store, store.effectiveSymbols({ fileId: fileId(store.repo(), rel) }));
    } finally {
      store.close();
    }
  }

  it("without options it reads the overlay and reports only edges the main layer lacks", async () => {
    await setup("overlay-groups", [ORDERS, CATALOG]);
    await edit("src/orders/invoice.ts", EDIT);
    const found = await withChanged("src/orders/invoice.ts", (store, changed) =>
      crossingFindings(store, changed, ["src/orders/invoice.ts"]),
    );
    expect(found).toEqual([
      {
        kind: "crossing",
        srcName: "totalDue",
        srcPath: "src/orders/invoice.ts",
        srcLine: 3,
        srcGroup: "Orders",
        dstName: "formatPrice",
        dstPath: "src/catalog/price.ts",
        dstLine: 1,
        dstGroup: "Catalog",
      },
    ]);
    const same = await withChanged("src/orders/invoice.ts", (store, changed) =>
      crossingFindings(store, changed, ["src/orders/invoice.ts"], {}),
    );
    expect(same).toEqual(found);
  });

  it("opts.groups replaces the groups of the overlay", async () => {
    await setup("overlay-groups", [ORDERS, CATALOG]);
    await edit("src/orders/invoice.ts", EDIT);
    const none = await withChanged("src/orders/invoice.ts", (store, changed) =>
      crossingFindings(store, changed, ["src/orders/invoice.ts"], { groups: [] }),
    );
    expect(none).toEqual([]);
    const renamed = await withChanged("src/orders/invoice.ts", (store, changed) =>
      crossingFindings(store, changed, ["src/orders/invoice.ts"], {
        groups: [
          { ...ORDERS, name: "Orders (renamed)" },
          { ...CATALOG, name: "Catalog (renamed)" },
        ],
      }),
    );
    expect(renamed.map((f) => [f.srcGroup, f.dstGroup])).toEqual([["Orders (renamed)", "Catalog (renamed)"]]);
  });

  it("opts.allEdges reports an edge the main layer already has", async () => {
    await setup("overlay-groups", [ORDERS, { ...CATALOG, mayUse: [] }]);
    const run = (opts?: { allEdges?: boolean }) =>
      withChanged("src/catalog/cart.ts", (store, changed) =>
        crossingFindings(store, changed, ["src/catalog/cart.ts"], opts),
      );
    expect(await run()).toEqual([]);
    expect(await run({ allEdges: false })).toEqual([]);
    const all = await run({ allEdges: true });
    expect(all.map((f) => `${f.srcName}>${f.dstName}`)).toEqual(["cartTotal>totalDue"]);
  });
});

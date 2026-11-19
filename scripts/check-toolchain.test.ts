import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkToolchain } from "./toolchain.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(
  nvmrc: string | null,
  engines: Record<string, string>,
  packageManager = "pnpm@10.31.0",
): string {
  const root = mkdtempSync(join(tmpdir(), "gantry-toolchain-"));
  dirs.push(root);
  if (nvmrc !== null) writeFileSync(join(root, ".nvmrc"), `${nvmrc}\n`);
  writeFileSync(join(root, "package.json"), JSON.stringify({ engines, packageManager }));
  return root;
}
const good = { node: ">=26 <27", pnpm: "10.31.0" };

describe("checkToolchain", () => {
  it("passes when the running Node major matches .nvmrc", () => {
    expect(checkToolchain(scratch("26", good), "26.13.0")).toEqual([]);
  });
  it("names .nvmrc when the running Node major differs", () => {
    const [p] = checkToolchain(scratch("26", good), "24.1.0");
    expect(p).toMatch(/^\.nvmrc: pins Node 26 but this is Node 24\.1\.0/);
  });
  it("names .nvmrc when it is missing", () => {
    expect(checkToolchain(scratch(null, good), "26.0.0")[0]).toMatch(/^\.nvmrc:/);
  });
  it("names package.json when engines.node disagrees with .nvmrc", () => {
    const p = checkToolchain(scratch("26", { ...good, node: ">=22" }), "26.0.0");
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/^package\.json: engines\.node/);
  });
  it("names package.json when engines.pnpm disagrees with packageManager", () => {
    const p = checkToolchain(scratch("26", { ...good, pnpm: "9.0.0" }), "26.0.0");
    expect(p[0]).toMatch(/^package\.json: engines\.pnpm is 9\.0\.0/);
  });
  it("passes for this repository's own pins", () => {
    expect(checkToolchain(process.cwd(), "26.0.0")).toEqual([]);
  });
});

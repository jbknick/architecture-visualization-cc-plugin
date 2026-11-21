/**
 * Builds a fixture repo for a hand run: `pnpm exec tsx scripts/fixture-repo.ts <name> <dest>`.
 *
 * Writes `fixtures/<name>` into `<dest>` (which must not exist), makes it a git repo on `main`, and, for a fixture
 * that has a `fixtures/<name>.feature/` overlay, adds branch `feature` with the overlay and checks `main` out again.
 * The commits have a fixed author and date, so the SHAs are the same on every machine. The repo name in ids is the
 * last part of `<dest>`.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type FixtureName, materializeInto } from "../packages/core/test/helpers/fixture.js";

const FIXTURES_WITH_FEATURE = new Set<FixtureName>(["deep-radius"]);

async function main(): Promise<void> {
  const [name, dest] = process.argv.slice(2);
  if (name === undefined || dest === undefined) {
    process.stderr.write("usage: tsx scripts/fixture-repo.ts <fixture name> <dest dir>\n");
    process.exitCode = 2;
    return;
  }
  const target = resolve(dest);
  if (existsSync(target)) {
    process.stderr.write(`fixture-repo: ${target} already exists\n`);
    process.exitCode = 2;
    return;
  }
  const fixture = name as FixtureName;
  await materializeInto(fixture, target, { feature: FIXTURES_WITH_FEATURE.has(fixture) });
  process.stdout.write(`${target}\n`);
}

await main();

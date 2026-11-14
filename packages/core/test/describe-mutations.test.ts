// The mutation runner must leave the source tree as it found it when it is interrupted (review of #121). The test runs
// the real script against a scratch copy of the first file it mutates, with a stub test command, and sends SIGTERM
// while a mutation is in place.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..", "..");

it("restores the mutated file when the runner is terminated mid-run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gantry-mut-"));
  const original = readFileSync(join(root, "packages", "core", "src", "describe", "validate.ts"), "utf8");
  writeFileSync(join(dir, "validate.ts"), original);
  const marker = join(dir, "baseline-done");
  // first call (the baseline) exits 0 at once; later calls (a mutation in place) hang until killed
  const stub = `node -e "const f=require('fs');const m='${marker}';if(!f.existsSync(m)){f.writeFileSync(m,'1');process.exit(0)}setTimeout(()=>{},60000)"`;
  const child = spawn(join(root, "node_modules", ".bin", "tsx"), ["scripts/describe-mutations.ts"], {
    cwd: root,
    env: {
      ...process.env,
      GANTRY_MUTATION_DIR: dir,
      GANTRY_MUTATION_CMD: stub,
      GANTRY_MUTATION_LIMIT: "1",
    },
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c)));
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && readFileSync(join(dir, "validate.ts"), "utf8") === original) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(existsSync(marker)).toBe(true);
  expect(readFileSync(join(dir, "validate.ts"), "utf8")).not.toBe(original); // mutation is in place
  // signal the tsx child directly: pnpm and tsx forward it to the script
  child.kill("SIGTERM");
  await exited;
  await new Promise((r) => setTimeout(r, 300));
  expect(readFileSync(join(dir, "validate.ts"), "utf8")).toBe(original);
}, 40_000);

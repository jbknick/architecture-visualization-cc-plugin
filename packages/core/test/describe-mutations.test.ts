// The mutation runner works on a temporary copy and never edits the checkout (issue #258). These tests run the real
// script with a stub test command and a cap of one mutation: one sends SIGTERM mid-run and checks that nothing in the
// checkout changed and no temporary copy is left; the other checks that the mutation reaches the copy and only the copy.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..", "..");
const validatePath = join(root, "packages", "core", "src", "describe", "validate.ts");
const sha = (t: string | Buffer) => createHash("sha256").update(t).digest("hex");
const gitStatus = () => spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout;
const copies = (tmp: string) => readdirSync(tmp).filter((n) => n.startsWith("gantry-mut-"));

const scratch: string[] = [];
const scratchDir = (label: string) => {
  const d = mkdtempSync(join(tmpdir(), `gantry-test-${label}-`));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const wait = async (done: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done()) await new Promise((r) => setTimeout(r, 50));
};

it("leaves the checkout unchanged and removes its temporary copy when terminated mid-run", async () => {
  const dir = scratchDir("src");
  const privateTmp = scratchDir("tmp"); // the child's tmpdir(), so only this run's copy can appear in it
  const original = readFileSync(validatePath, "utf8");
  writeFileSync(join(dir, "validate.ts"), original);
  const before = gitStatus();
  const marker = join(dir, "baseline-done");
  const running = join(dir, "mutation-running");
  // first call (the baseline) exits 0 at once; the next (a mutation in place) hangs until killed
  const stub = `node -e "const f=require('fs');if(!f.existsSync('${marker}')){f.writeFileSync('${marker}','1');process.exit(0)}f.writeFileSync('${running}','1');setTimeout(()=>{},60000)"`;
  const child = spawn(join(root, "node_modules", ".bin", "tsx"), ["scripts/describe-mutations.ts"], {
    cwd: root,
    env: {
      ...process.env,
      TMPDIR: privateTmp,
      GANTRY_MUTATION_DIR: dir,
      GANTRY_MUTATION_CMD: stub,
      GANTRY_MUTATION_LIMIT: "1",
    },
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c)));
  await wait(() => existsSync(running), 25_000);
  expect(existsSync(running)).toBe(true);
  expect(copies(privateTmp)).toHaveLength(1); // the copy exists while the mutation is in place
  // signal the tsx child directly: pnpm and tsx forward it to the script
  child.kill("SIGTERM");
  await exited;
  await new Promise((r) => setTimeout(r, 300));
  expect(readFileSync(join(dir, "validate.ts"), "utf8")).toBe(original);
  expect(readFileSync(validatePath, "utf8")).toBe(original);
  expect(copies(privateTmp)).toEqual([]);
  if (before === "") expect(gitStatus()).toBe("");
}, 40_000);

it("applies the mutation to the copy in the test command's cwd, not to the checkout", async () => {
  const out = scratchDir("marker");
  const original = readFileSync(validatePath, "utf8");
  const originalHash = sha(original);
  const marker = join(out, "hashes");
  // the stub does not test anything: it records the hash of validate.ts as it sees it in its cwd
  const stub = `node -e "const c=require('crypto'),f=require('fs');const p='packages/core/src/describe/validate.ts';f.appendFileSync('${marker}',c.createHash('sha256').update(f.readFileSync(p)).digest('hex')+'\\n')"`;
  const run = spawnSync(join(root, "node_modules", ".bin", "tsx"), ["scripts/describe-mutations.ts"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GANTRY_MUTATION_CMD: stub, GANTRY_MUTATION_LIMIT: "1" },
  });
  expect(run.stdout).toContain("SURVIVED"); // the stub never fails, so the mutation survives; only the hashes matter
  const [baseline, mutated] = readFileSync(marker, "utf8").trim().split("\n");
  expect(baseline).toBe(originalHash);
  const expected = original.replace("o.behavior.length > HARD_MAX_BEHAVIOR_CHARS", "false");
  expect(expected).not.toBe(original);
  expect(mutated).toBe(sha(expected));
  expect(sha(readFileSync(validatePath))).toBe(originalHash);
}, 60_000);

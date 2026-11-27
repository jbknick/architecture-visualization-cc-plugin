import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packProtocol } from "./pack.js";

// Offline install check for the protocol tarball: build packages/protocol into a scratch copy of the repository, pack it,
// extract it into <temp>/node_modules/@gantry/protocol beside a symlink to this repository's installed zod, and import it
// the way a consumer does. No npm registry is used.
const REPO = join(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "gantry-protocol-install-"));
const consumer = join(scratch, "consumer");
const node = (code: string) =>
  execFileSync(process.execPath, ["-e", code], { cwd: consumer, encoding: "utf8" }).trim();

beforeAll(() => {
  const root = join(scratch, "repo");
  mkdirSync(join(root, "packages/protocol"), { recursive: true });
  cpSync(join(REPO, "packages/protocol/package.json"), join(root, "packages/protocol/package.json"));
  cpSync(join(REPO, "packages/protocol/examples"), join(root, "packages/protocol/examples"), {
    recursive: true,
  });
  cpSync(join(REPO, "LICENSE"), join(root, "LICENSE"));
  const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin/tsc");
  execFileSync(
    process.execPath,
    [
      tsc,
      "-p",
      join(REPO, "packages/protocol/tsconfig.build.json"),
      "--composite",
      "false",
      "--incremental",
      "false",
      "--outDir",
      join(root, "packages/protocol/dist"),
    ],
    { cwd: REPO, stdio: "pipe" },
  );
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "-A"],
  ])
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "x",
    ],
    {
      cwd: root,
      stdio: "pipe",
    },
  );
  const { tarball } = packProtocol(root, "0.1.0");
  const target = join(consumer, "node_modules/@gantry/protocol");
  mkdirSync(target, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", target, "--strip-components=1"]);
  const zod = dirname(
    createRequire(join(REPO, "packages/protocol/package.json")).resolve("zod/package.json"),
  );
  symlinkSync(zod, join(consumer, "node_modules/zod"), "dir");
  writeFileSync(join(consumer, "package.json"), '{"type":"module"}\n');
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the protocol tarball, extracted beside zod", () => {
  it("exposes the package entry point: PROTOCOL_VERSION is 1", () => {
    expect(node("import('@gantry/protocol').then(m => console.log(m.PROTOCOL_VERSION))")).toBe("1");
  });

  it("resolves the ./testing entry point", () => {
    expect(node("import('@gantry/protocol/testing').then(m => console.log(Object.keys(m).length > 0))")).toBe(
      "true",
    );
  });

  it("carries no test file", () => {
    expect(existsSync(join(consumer, "node_modules/@gantry/protocol/dist/schemas.test.js"))).toBe(false);
    expect(existsSync(join(consumer, "node_modules/@gantry/protocol/dist/testing/fakeServer.js"))).toBe(true);
  });
});

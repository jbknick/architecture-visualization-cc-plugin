// The install step of action.yml fails open (issue #282): a bad input, a failed download or a checksum mismatch is
// logged, written to the step's `failed` output and the step exits 0; a tarball that does not match is never
// extracted. The step's script is cut out of action.yml and run with bash against a directory of files (curl reads
// file:// URLs), so no network is used.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const yml = readFileSync(join(import.meta.dirname, "../action.yml"), "utf8");

/** The `run: |` script of the step with this name, without its indentation. */
function stepScript(name: string): string {
  const start = yml.indexOf(`- name: ${name}`);
  const run = yml.indexOf("run: |\n", start);
  const next = yml.indexOf("\n    - name:", run);
  const block = yml.slice(run + "run: |\n".length, next === -1 ? undefined : next);
  return block
    .split("\n")
    .map((l) => l.replace(/^ {8}/, ""))
    .join("\n");
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gantry-install-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function install(env: Record<string, string>) {
  const temp = join(dir, "runner");
  mkdirSync(temp, { recursive: true });
  const out = join(dir, "output.txt");
  writeFileSync(out, "");
  const r = spawnSync("bash", ["-c", stepScript("Install Gantry")], {
    env: { PATH: process.env.PATH ?? "", RUNNER_TEMP: temp, GITHUB_OUTPUT: out, ...env },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, output: readFileSync(out, "utf8"), temp };
}

describe("install step of action.yml", () => {
  it("exits 0 and reports a checksum mismatch loudly, without extracting the tarball", () => {
    const rel = join(dir, "release");
    mkdirSync(rel);
    // a tarball that, if it were extracted, would leave gantry/bin/gantry behind
    const src = join(dir, "src/gantry/bin");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "gantry"), "#!/bin/sh\necho 0.1.0\n");
    spawnSync("tar", ["-czf", join(rel, "gantry-0.1.0.tgz"), "-C", join(dir, "src"), "gantry"]);
    const real = createHash("sha256")
      .update(readFileSync(join(rel, "gantry-0.1.0.tgz")))
      .digest("hex");
    writeFileSync(join(rel, "gantry-0.1.0.tgz.sha256"), `${real}  gantry-0.1.0.tgz\n`);
    const r = install({
      GANTRY_VERSION: "0.1.0",
      GANTRY_SHA256: "0".repeat(64),
      GANTRY_RELEASE_BASE: `file://${rel}`,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("::error title=Gantry::checksum mismatch");
    expect(r.output).toMatch(/^failed=checksum mismatch for gantry-0\.1\.0\.tgz/m);
    expect(r.output).not.toContain("home=");
    expect(existsSync(join(r.temp, "gantry-install/gantry"))).toBe(false);
    expect(existsSync(join(r.temp, "gantry-install/gantry-0.1.0.tgz"))).toBe(false);
  });

  it("exits 0 when the download fails", () => {
    const r = install({
      GANTRY_VERSION: "0.1.0",
      GANTRY_SHA256: "a".repeat(64),
      GANTRY_RELEASE_BASE: `file://${join(dir, "nothing-here")}`,
    });
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/^failed=download of gantry-0\.1\.0\.tgz failed$/m);
    expect(r.stdout).toContain("::warning title=Gantry::");
  });

  it("exits 0 for a version or checksum that is not valid", () => {
    const badVersion = install({ GANTRY_VERSION: "latest", GANTRY_SHA256: "a".repeat(64) });
    expect(badVersion.status).toBe(0);
    expect(badVersion.output).toMatch(/^failed=version must look like/m);
    const badSha = install({ GANTRY_VERSION: "0.1.0", GANTRY_SHA256: "xyz" });
    expect(badSha.status).toBe(0);
    expect(badSha.output).toMatch(/^failed=sha256 must be 64 hex digits$/m);
  });
});

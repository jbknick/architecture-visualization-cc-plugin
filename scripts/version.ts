// Version management (issue #187). The root package.json holds the version; the files below are kept equal to it.
// `claude plugin update` compares plugin.json's version, so a build with an unchanged version is never picked up.
// Used by scripts/check-version.ts (part of `pnpm check`) and scripts/release.ts (`pnpm release`). Node built-ins and git only.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Root first (the source of truth), then every file that must carry the same version. */
export const VERSION_FILES = [
  "package.json",
  "plugin/.claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  "packages/core/package.json",
  "packages/cli/package.json",
  "packages/mcp/package.json",
  "packages/explorer/package.json",
];

/** Paths whose changes ship in the plugin (plugin/ plus the packages bundled into plugin/dist, and the bundler config). */
export const CONTENT_PATHS = [
  "plugin",
  "packages/core/src",
  "packages/cli/src",
  "packages/mcp/src",
  "packages/explorer/server",
  "packages/explorer/src",
  "packages/explorer/web/src",
  "tsup.config.ts",
];

const SEMVER = /^\d+\.\d+\.\d+$/;

export function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The top-level "version" of a JSON file, or null when the file has none (the marketplace carries none today). */
export function readVersion(root: string, file: string): string | null {
  const data = JSON.parse(readFileSync(join(root, file), "utf8")) as { version?: unknown };
  return typeof data.version === "string" ? data.version : null;
}

/** Mismatch messages naming the file; empty when every file equals the root version. */
export function checkSync(root: string): string[] {
  const rootFile = VERSION_FILES[0] as string;
  const want = readVersion(root, rootFile);
  if (want === null || !SEMVER.test(want)) return [`${rootFile}: version "${want}" is not x.y.z`];
  const problems: string[] = [];
  for (const file of VERSION_FILES.slice(1)) {
    if (!existsSync(join(root, file))) continue;
    const got = readVersion(root, file);
    if (got === null) {
      if (file !== ".claude-plugin/marketplace.json") problems.push(`${file}: no version (root is ${want})`);
      continue; // the marketplace entry may omit it
    }
    if (got !== want) problems.push(`${file}: version ${got} differs from ${rootFile} (${want})`);
  }
  return problems;
}

export function nextVersion(current: string, bump: string): string {
  if (SEMVER.test(bump)) return bump;
  if (!SEMVER.test(current)) throw new Error(`current version "${current}" is not x.y.z`);
  const [major, minor, patch] = current.split(".").map(Number) as [number, number, number];
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown bump "${bump}": use patch, minor, major or x.y.z`);
}

/** Rewrite the first top-level "version" value in place, so the file's formatting stays untouched. */
export function writeVersion(root: string, file: string, version: string): boolean {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  const re = /^(\s*"version"\s*:\s*)"[^"]*"/m;
  if (!re.test(text)) return false;
  writeFileSync(path, text.replace(re, `$1"${version}"`));
  return true;
}

/** The newest `v*` tag reachable from HEAD, or null when none exists. */
export function lastTag(root: string): string | null {
  try {
    return git(root, ["describe", "--tags", "--match", "v*", "--abbrev=0"]) || null;
  } catch {
    return null;
  }
}

const isTestFile = (p: string) =>
  /\.test\.tsx?$/.test(p) || /(^|\/)(e2e|test|tests|__snapshots__)\//.test(p) || /\.md$/.test(p);

/** Plugin content that changed since `tag` (tests and docs excluded). */
export function changedContent(root: string, tag: string): string[] {
  const out = git(root, ["diff", "--name-only", `${tag}..HEAD`, "--", ...CONTENT_PATHS]);
  return out
    .split("\n")
    .filter((p) => p && !isTestFile(p))
    .sort();
}

export type ContentCheck =
  | { status: "no-tag" }
  | { status: "ok"; tag: string }
  | { status: "needs-bump"; tag: string; files: string[] };

/** Did plugin content change since the last v* tag while the version stayed what it was at that tag? */
export function checkContent(root: string): ContentCheck {
  const tag = lastTag(root);
  if (!tag) return { status: "no-tag" };
  const files = changedContent(root, tag);
  if (files.length === 0) return { status: "ok", tag };
  let tagged: string | null = null;
  try {
    tagged = (JSON.parse(git(root, ["show", `${tag}:package.json`])) as { version?: string }).version ?? null;
  } catch {
    // a tag without a root package.json: treat as unbumped
  }
  if (tagged !== null && tagged !== readVersion(root, "package.json")) return { status: "ok", tag };
  return { status: "needs-bump", tag, files };
}

/** One dated CHANGELOG section from the commit subjects (merged PR titles) since the last tag. */
export function changelogSection(root: string, version: string, date: string): string {
  const tag = lastTag(root);
  const range = tag ? [`${tag}..HEAD`] : [];
  const subjects = git(root, ["log", ...range, "--no-merges", "--pretty=format:%s"])
    .split("\n")
    .filter(Boolean);
  const lines = subjects.length ? subjects.map((s) => `- ${s}`) : ["- No changes recorded."];
  return `## ${version} - ${date}\n\n${lines.join("\n")}\n`;
}

export function prependChangelog(root: string, section: string): void {
  const path = join(root, "CHANGELOG.md");
  const header = "# Changelog\n\nOne section per release, newest first. Written by `pnpm release`.\n\n";
  const old = existsSync(path) ? readFileSync(path, "utf8") : header;
  const at = old.search(/^## /m);
  const next =
    at === -1 ? `${old.trimEnd()}\n\n${section}` : `${old.slice(0, at)}${section}\n${old.slice(at)}`;
  writeFileSync(path, next);
}

/** Bump every version file, write the CHANGELOG, commit and tag. Never pushes. Returns the new version. */
export function release(root: string, bump: string, date = new Date().toISOString().slice(0, 10)): string {
  const current = readVersion(root, VERSION_FILES[0] as string) as string;
  const problems = checkSync(root);
  if (problems.length) throw new Error(`versions are out of sync:\n${problems.join("\n")}`);
  if (git(root, ["status", "--porcelain"]))
    throw new Error("the working tree is not clean: commit or stash first");
  const version = nextVersion(current, bump);
  if (version === current) throw new Error(`version is already ${current}`);
  const tag = `v${version}`;
  if (git(root, ["tag", "--list", tag])) throw new Error(`tag ${tag} already exists`);
  const section = changelogSection(root, version, date);
  const touched: string[] = [];
  for (const file of VERSION_FILES) {
    if (existsSync(join(root, file)) && writeVersion(root, file, version)) touched.push(file);
  }
  prependChangelog(root, section);
  git(root, ["add", "CHANGELOG.md", ...touched]);
  git(root, ["commit", "-m", `Release ${tag}`]);
  git(root, ["tag", "-a", tag, "-m", `Release ${tag}`]);
  return version;
}

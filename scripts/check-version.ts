// Part of `pnpm check` (issue #187). Fails when a version file differs from the root package.json (naming the file), or a version in
// scripts/release-deps/package.json (the release tarball's native dependencies) differs from it (naming the package).
// Plugin content changed since the last v* tag without a version bump is a warning by default: a feature branch
// changes plugin content in nearly every PR, and the bump happens once, in `pnpm release`. Pass --strict
// (`pnpm version:check --strict`) to make it an error, for example before cutting a release.
import { checkContent, checkReleaseDeps, checkSync } from "./version.js";

const root = process.cwd();
const problems = [...checkSync(root), ...checkReleaseDeps(root)];
if (problems.length) {
  console.error(`Version files are out of sync:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  console.error(
    "Run `pnpm release <patch|minor|major|x.y.z>`, or edit them to match the root package.json (for scripts/release-deps, also regenerate its package-lock.json).",
  );
  process.exit(1);
}
const content = checkContent(root);
if (content.status === "needs-bump") {
  const msg = `Plugin content changed since ${content.tag} but the version did not (${content.files.length} files, for example ${content.files[0]}). Installed copies only update after \`pnpm release\` bumps it.`;
  if (process.argv.includes("--strict")) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(`warning: ${msg}`);
}

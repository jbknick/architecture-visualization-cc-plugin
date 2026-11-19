// `pnpm release <patch|minor|major|x.y.z>` (issues #187, #281): bumps every version file, adds a dated CHANGELOG section
// from the commit subjects since the last v* tag, commits and tags v<version>, then builds and packs
// dist/gantry-<version>.tgz and its .sha256. It never pushes or uploads: review, then push the branch and the tag and
// create the GitHub release yourself with the printed commands.
import { release } from "./version.js";

const bump = process.argv[2];
if (!bump) {
  console.error("Usage: pnpm release <patch|minor|major|x.y.z>");
  process.exit(2);
}
try {
  const { version, pack } = release(process.cwd(), bump);
  console.log(`Released v${version}: committed and tagged locally. Nothing was pushed or uploaded.`);
  console.log(`Tarball: ${pack.tarball}\nChecksum: ${pack.sha256File}`);
  console.log("Next, when ready:");
  console.log(`  git push && git push origin v${version}`);
  console.log(
    `  gh release create v${version} dist/gantry-${version}.tgz dist/gantry-${version}.tgz.sha256 --notes-from-tag`,
  );
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

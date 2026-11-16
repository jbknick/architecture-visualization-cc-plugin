// `pnpm release <patch|minor|major|x.y.z>` (issue #187): bumps every version file, adds a dated CHANGELOG section from
// the commit subjects since the last v* tag, commits and tags v<version>. It never pushes: review, then push the
// branch and the tag yourself.
import { release } from "./version.js";

const bump = process.argv[2];
if (!bump) {
  console.error("Usage: pnpm release <patch|minor|major|x.y.z>");
  process.exit(2);
}
try {
  const version = release(process.cwd(), bump);
  console.log(`Released v${version}: committed and tagged locally. Nothing was pushed.`);
  console.log(`Push when ready: git push && git push origin v${version}`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

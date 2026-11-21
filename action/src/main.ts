// Entry point of the Action's script; bundled by tsup into plugin/dist/action.js (and so into the release tarball).
import { run } from "./run.js";

try {
  const r = await run(process.env);
  console.log(`gantry-action: ${r.comment}`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  // A review that cannot be produced fails the job; a comment that cannot be posted never does (see run.ts).
  console.log(`::error title=Gantry::${msg.replace(/[\r\n]+/g, " ")}`);
  process.exitCode = 1;
}

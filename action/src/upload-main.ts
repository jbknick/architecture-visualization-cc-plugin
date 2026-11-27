// Entry point of the upload step; bundled by tsup into plugin/dist/upload.js (and so into the release tarball). It
// always exits 0: an upload that fails is a warning line, never a failed job.
import { runUpload } from "./upload.js";

try {
  await runUpload(process.env);
} catch {
  console.log("::warning title=Gantry::upload failed: unexpected error");
}
process.exitCode = 0;

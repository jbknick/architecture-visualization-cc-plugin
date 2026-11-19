// Part of `pnpm check`. Fails (naming the file) when the running Node major differs from .nvmrc,
// or when .nvmrc, engines and packageManager disagree.
import { checkToolchain } from "./toolchain.js";

const problems = checkToolchain(process.cwd());
if (problems.length) {
  console.error(`Toolchain mismatch:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}

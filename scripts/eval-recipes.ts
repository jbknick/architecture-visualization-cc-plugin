// pnpm eval:recipes [--only <name>...] [--repos <file>] [--recipes-dir <dir>] [--labels-dir <dir>] (spec section 13).
// Scores every case that has a committed reference recipe, ignoring any recipe inside the clone.
// Exit codes as eval:score; 1 also when two dumps from fresh data dirs differ.
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  InputError,
  loadCase,
  parseDump,
  parseFlags,
  recipesDir,
  requireCloneAndBuild,
  runDump,
  score,
} from "./eval-lib.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function main(): number {
  try {
    const { values, lists, positional } = parseFlags(
      process.argv.slice(2),
      ["--repos", "--recipes-dir", "--labels-dir"],
      ["--only"],
    );
    if (positional.length) throw new InputError("usage: pnpm eval:recipes [--only <name>...]");
    const dir = values["recipes-dir"] ? resolve(values["recipes-dir"]) : recipesDir;
    const found = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith(".recipe.json"))
          .map((f) => f.slice(0, -".recipe.json".length))
          .sort()
      : [];
    const only = lists.only ?? [];
    for (const n of only) if (!found.includes(n)) throw new InputError(`no reference recipe for ${n}`);
    const cases = found.filter((n) => only.length === 0 || only.includes(n));
    if (found.length === 0) {
      console.log("no reference recipes");
      return 0;
    }
    let code = 0;
    let passed = 0;
    for (const name of cases) {
      const { repo, labels } = loadCase(name, { repos: values.repos, labelsDir: values["labels-dir"] });
      const clone = requireCloneAndBuild(repo);
      const recipe = join(dir, `${name}.recipe.json`);
      const first = runDump(clone, recipe);
      const second = runDump(clone, recipe);
      const result = score(name, labels, parseDump(first));
      console.log(JSON.stringify(result));
      if (sha256(first) !== sha256(second)) {
        console.error(`eval:recipes: ${name}: two dumps from fresh data dirs differ`);
        code = 1;
      } else if (result.pass) passed++;
      if (!result.pass) code = 1;
    }
    console.log(JSON.stringify({ summary: { cases: cases.length, passed } }));
    return code;
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    console.error(`eval:recipes: ${err.message}`);
    return 2;
  }
}

process.exitCode = main();

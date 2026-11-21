// pnpm tsx evals/oss/labels-check.ts <case> [--sample 10] (spec section 13, #268).
// Self-check of the hand labels of a TypeScript framework case: the label file passes the strict schema, every
// label's file exists and holds what it names (`check-labels` rules), and the stack's registration greps find no
// candidate site that is neither labelled nor listed in evals/oss/labels/README.md as "- `<case>` `<file>:<line>`:
// <reason>". Prints `<n> unlabelled candidates`; with `--sample <n>` also every n-th label (id order) with its
// source line, for the maintainer's spot check.
// Exit 0 ok, 1 a label is wrong or a candidate is unlabelled, 2 usage or input error.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkLabels, labelCount } from "../../scripts/eval-label-check.js";
import { sample, staleListed, unlabelled } from "../../scripts/eval-label-scan.js";
import { InputError, labelsDir, loadCase, parseFlags, targetDir } from "../../scripts/eval-lib.js";

function main(argv: string[]): number {
  try {
    const { values, positional } = parseFlags(argv, ["--sample"], []);
    if (positional.length !== 1)
      throw new InputError("usage: pnpm tsx evals/oss/labels-check.ts <case> [--sample 10]");
    const name = positional[0] as string;
    const every = values.sample === undefined ? 0 : Number(values.sample);
    if (values.sample !== undefined && !(Number.isInteger(every) && every > 0))
      throw new InputError("--sample needs a positive integer");
    const { repo, labels } = loadCase(name, {});
    const dir = targetDir(repo);
    if (!existsSync(dir)) throw new InputError(`${dir} is missing: run pnpm eval:clone`);
    const readme = readFileSync(join(labelsDir, "README.md"), "utf8");
    const problems = checkLabels(labels, dir);
    const missing = unlabelled(dir, repo, labels, readme);
    const stale = staleListed(dir, repo, readme, labels);
    console.log(`${problems.length ? "FAIL" : "ok"} ${name} ${labelCount(labels)} labels`);
    for (const p of problems) console.log(`  ${p}`);
    for (const c of missing) console.log(`  unlabelled ${c.file}:${c.line} ${c.text}`);
    for (const s of stale) console.log(`  README lists ${s}, which the scan does not find`);
    console.log(`${missing.length} unlabelled candidates`);
    if (every)
      for (const s of sample(labels, dir, every, repo.stack))
        console.log(`${s.id}  ${s.file}:${s.line}  ${s.text}`);
    return problems.length || missing.length || stale.length ? 1 : 0;
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    console.error(`labels-check: ${err.message}`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));

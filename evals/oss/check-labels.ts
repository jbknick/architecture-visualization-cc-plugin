// pnpm tsx evals/oss/check-labels.ts <case>... (spec section 13).
// Self-check of hand labels against the clones. A `linking-<x>` case: every label's file:line exists, its line
// holds a call, and the case has at least 20 linkable labels. Any other case: every file a label names exists,
// every handler, function and unresolved `file:line` is inside its file and holds what the label names.
// Prints `ok <case> <n> labels` per case.
// Exit 0 every case ok, 1 a label is wrong, 2 usage or input error (unknown case, bad labels, missing clone).
import { existsSync } from "node:fs";
import { checkLabels, labelCount } from "../../scripts/eval-label-check.js";
import { InputError, loadCase, targetDir } from "../../scripts/eval-lib.js";
import { checkLinking, cloneDirOf, isLinkingCase, loadLinkingCase } from "../../scripts/eval-linking.js";

/** Problems and label count of one case; throws InputError when the case or its clone is missing. */
function checkCase(name: string): { count: number; problems: string[] } {
  if (isLinkingCase(name)) {
    const { labels, repos } = loadLinkingCase(name);
    const cloneOf = cloneDirOf(repos);
    for (const r of labels.repos)
      if (!existsSync(cloneOf(r.name)))
        throw new InputError(`${cloneOf(r.name)} is missing: run pnpm eval:clone`);
    return { count: labels.requests.length, problems: checkLinking(labels, cloneOf) };
  }
  const { repo, labels } = loadCase(name, {});
  const dir = targetDir(repo);
  if (!existsSync(dir)) throw new InputError(`${dir} is missing: run pnpm eval:clone`);
  return { count: labelCount(labels), problems: checkLabels(labels, dir) };
}

function main(args: string[]): number {
  try {
    if (!args.length) throw new InputError("usage: pnpm tsx evals/oss/check-labels.ts <case>...");
    let failed = false;
    for (const name of args) {
      const { count, problems } = checkCase(name);
      if (problems.length) {
        failed = true;
        console.log(`FAIL ${name} ${count} labels`);
        for (const p of problems) console.log(`  ${p}`);
      } else console.log(`ok ${name} ${count} labels`);
    }
    return failed ? 1 : 0;
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    console.error(`check-labels: ${err.message}`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));

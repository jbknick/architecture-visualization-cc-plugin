// pnpm tsx evals/oss/check-labels.ts <case>... (spec section 13).
// Self-check of hand labels against the clones. A `linking-<x>` case: every label's file:line exists, its line
// holds a call, and the case has at least 20 linkable labels. Any other case: every file a label names exists,
// every handler, function and unresolved `file:line` is inside its file and holds what the label names.
// Prints `ok <case> <n> labels` per case.
// Exit 0 every case ok, 1 a label is wrong, 2 usage or input error (unknown case, bad labels, missing clone).
import { existsSync } from "node:fs";
import { sampleLabels, unlabelledCandidates } from "../../scripts/eval-label-candidates.js";
import { checkLabels, labelCount } from "../../scripts/eval-label-check.js";
import { InputError, type Labels, loadCase, targetDir } from "../../scripts/eval-lib.js";
import { checkLinking, cloneDirOf, isLinkingCase, loadLinkingCase } from "../../scripts/eval-linking.js";

/** Problems and label count of one case; throws InputError when the case or its clone is missing. */
function checkCase(name: string): {
  count: number;
  problems: string[];
  candidates?: number;
  labels?: Labels;
} {
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
  const problems = checkLabels(labels, dir);
  // A held-out data-access case (table, read and write labels on a known ORM or client): every definition and
  // access site the stack's patterns find must be labelled or listed in `unresolved`.
  const scanned =
    repo.role === "held-out" && ["table", "read", "write"].every((k) => labels.kinds.includes(k as never));
  const candidates = scanned ? unlabelledCandidates(labels, dir, repo.stack) : null;
  if (candidates) problems.push(...candidates);
  return { count: labelCount(labels), problems, candidates: candidates?.length, labels };
}

function main(allArgs: string[]): number {
  try {
    // `--sample <n>`: also print every n-th label in sorted order, for the maintainer's spot check.
    const at = allArgs.indexOf("--sample");
    const sample = at < 0 ? 0 : Number(allArgs[at + 1]);
    if (at >= 0 && !(Number.isInteger(sample) && sample > 0))
      throw new InputError("--sample needs a positive whole number");
    const args = at < 0 ? allArgs : allArgs.filter((_, i) => i !== at && i !== at + 1);
    if (!args.length)
      throw new InputError("usage: pnpm tsx evals/oss/check-labels.ts <case>... [--sample <n>]");
    let failed = false;
    for (const name of args) {
      const { count, problems, candidates, labels } = checkCase(name);
      const tail = candidates === undefined ? "" : `, ${candidates} unlabelled candidates`;
      if (problems.length) {
        failed = true;
        console.log(`FAIL ${name} ${count} labels${tail}`);
        for (const p of problems) console.log(`  ${p}`);
      } else console.log(`ok ${name} ${count} labels${tail}`);
      if (sample && labels) for (const s of sampleLabels(labels, sample)) console.log(`  sample ${s}`);
    }
    return failed ? 1 : 0;
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    console.error(`check-labels: ${err.message}`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));

// pnpm tsx evals/oss/check-labels.ts <linking-case>... (spec section 13).
// Self-check of call-linking labels against the clones: every label's file:line exists and its line holds a
// call, and a case has at least 20 linkable labels. Prints `ok <case> <n> labels` per case.
// Exit 0 every case ok, 1 a label is wrong, 2 usage or input error (unknown case, bad labels, missing clone).
import { existsSync } from "node:fs";
import { InputError } from "../../scripts/eval-lib.js";
import { checkLinking, cloneDirOf, isLinkingCase, loadLinkingCase } from "../../scripts/eval-linking.js";

function main(args: string[]): number {
  try {
    if (!args.length || args.some((a) => !isLinkingCase(a)))
      throw new InputError("usage: pnpm tsx evals/oss/check-labels.ts linking-<case>...");
    let failed = false;
    for (const name of args) {
      const { labels, repos } = loadLinkingCase(name);
      const cloneOf = cloneDirOf(repos);
      for (const r of labels.repos)
        if (!existsSync(cloneOf(r.name)))
          throw new InputError(`${cloneOf(r.name)} is missing: run pnpm eval:clone`);
      const problems = checkLinking(labels, cloneOf);
      if (problems.length) {
        failed = true;
        console.log(`FAIL ${name} ${labels.requests.length} labels`);
        for (const p of problems) console.log(`  ${p}`);
      } else console.log(`ok ${name} ${labels.requests.length} labels`);
    }
    return failed ? 1 : 0;
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    console.error(`check-labels: ${err.message}`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));

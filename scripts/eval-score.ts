// pnpm eval:score <name> [--recipe <file>] [--dump <file>] [--labels <file>] [--repos <file>] (spec section 13).
// Exit 0: every scored kind passes. 1: a kind is below the bar. 2: usage or input error.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  InputError,
  loadCase,
  parseDump,
  parseFlags,
  requireCloneAndBuild,
  runDump,
  score,
} from "./eval-lib.js";
import { isLinkingCase, loadLinkingCase, runLinkingCase } from "./eval-linking.js";

function main(): number {
  try {
    const { values, positional } = parseFlags(
      process.argv.slice(2),
      ["--recipe", "--dump", "--labels", "--repos"],
      [],
    );
    const [name, ...rest] = positional;
    if (!name || rest.length)
      throw new InputError("usage: pnpm eval:score <name> [--recipe f] [--dump f] [--labels f] [--repos f]");
    if (isLinkingCase(name)) {
      if (values.dump || values.recipe)
        throw new InputError(
          "a linking case runs the built CLI on each of its repos: --dump and --recipe do not apply",
        );
      const linking = loadLinkingCase(name, { repos: values.repos, labels: values.labels });
      const result = runLinkingCase(linking.labels, linking.repos);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.pass ? 0 : 1;
    }
    const { repo, labels } = loadCase(name, { repos: values.repos, labels: values.labels });
    let text: string;
    if (values.dump) {
      try {
        text = readFileSync(resolve(values.dump), "utf8");
      } catch (err) {
        throw new InputError(`dump ${values.dump}: ${(err as Error).message}`);
      }
    } else {
      const clone = requireCloneAndBuild(repo);
      text = runDump(clone, values.recipe ? resolve(values.recipe) : undefined);
    }
    let dump: ReturnType<typeof parseDump>;
    try {
      dump = parseDump(text);
    } catch (err) {
      if (err instanceof InputError) throw err;
      throw new InputError(`dump is not valid JSON: ${(err as Error).message}`);
    }
    const result = score(name, labels, dump);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.pass ? 0 : 1;
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    console.error(`eval:score: ${err.message}`);
    return 2;
  }
}

process.exitCode = main();

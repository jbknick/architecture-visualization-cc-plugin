import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Problems with the pinned toolchain, each naming the file at fault. Empty when everything agrees. */
export function checkToolchain(root: string, runningNode: string = process.versions.node): string[] {
  const problems: string[] = [];
  const nvmrcPath = join(root, ".nvmrc");
  const nvmrc = existsSync(nvmrcPath) ? readFileSync(nvmrcPath, "utf8").trim() : "";
  const pinned = /^v?(\d+)/.exec(nvmrc)?.[1];
  if (!pinned) problems.push(".nvmrc: missing or not a Node major version");
  else if (pinned !== runningNode.split(".")[0]) {
    problems.push(`.nvmrc: pins Node ${pinned} but this is Node ${runningNode}. Switch with \`nvm use\`.`);
  }

  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    engines?: { node?: string; pnpm?: string };
    packageManager?: string;
  };
  const pnpm = /^pnpm@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager ?? "")?.[1];
  if (!pnpm) problems.push("package.json: packageManager must be pnpm@<major.minor.patch>");
  if (pnpm && pkg.engines?.pnpm !== pnpm) {
    problems.push(
      `package.json: engines.pnpm is ${pkg.engines?.pnpm ?? "missing"} but packageManager pins ${pnpm}`,
    );
  }
  if (pinned && pkg.engines?.node !== `>=${pinned} <${Number(pinned) + 1}`) {
    problems.push(
      `package.json: engines.node is ${pkg.engines?.node ?? "missing"} but .nvmrc pins Node ${pinned}`,
    );
  }
  return problems;
}

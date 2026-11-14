import { nodeInfo } from "@gantry/core";
import type { Command } from "commander";
import { openFresh, table } from "./lookup.js";
import { EXIT_OK, fail, writeStdout } from "./shared.js";

export function registerNode(program: Command): void {
  program
    .command("node")
    .description("Show a symbol or file and its neighbors by edge kind")
    .argument("<target>", "node id (sym:..., file:...), path:line, or a file path")
    .option("--json", "print JSON")
    .action(async (target: string, opts: { json?: boolean }) => {
      try {
        const { store } = await openFresh(process.cwd());
        try {
          const info = nodeInfo(store, target);
          if (!info) throw new Error(`No node found for '${target}'`);
          const { node } = info;
          const rows = Object.entries(info.neighbors).flatMap(([kind, ids]) => ids.map((id) => [kind, id]));
          if ("fileId" in node) {
            const filePath = node.fileId.slice("file:".length);
            if (opts.json) {
              const { minhash: _minhash, ...rest } = node;
              writeStdout(`${JSON.stringify({ ...info, node: { ...rest, path: filePath } }, null, 2)}\n`);
            } else {
              const head = [
                `${node.name} (${node.kind}${node.exported ? ", exported" : ""})`,
                `  id:        ${node.id}`,
                `  location:  ${filePath}:${node.startLine}-${node.endLine}`,
                `  signature: ${node.signature}`,
                `  fan-in:    ${info.fanIn}`,
                `  fan-out:   ${info.fanOut}`,
              ];
              writeStdout(
                `${head.join("\n")}\n${rows.length > 0 ? `\n${table(["EDGE", "NODE"], rows)}` : ""}`,
              );
            }
          } else if (opts.json) {
            writeStdout(`${JSON.stringify(info, null, 2)}\n`);
          } else {
            const head = [
              `${node.path} (file)`,
              `  id:        ${node.id}`,
              `  fan-in:    ${info.fanIn}`,
              `  fan-out:   ${info.fanOut}`,
            ];
            writeStdout(`${head.join("\n")}\n${rows.length > 0 ? `\n${table(["EDGE", "NODE"], rows)}` : ""}`);
          }
        } finally {
          store.close();
        }
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}

import { type IndexResult, NotAGitRepoError } from "@gantry/core";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_NOT_A_REPO = 2;

/** Maps a thrown error to a message on stderr and an exit code (2 = not a git repo, 1 = anything else). */
export function fail(err: unknown): number {
  if (err instanceof NotAGitRepoError) {
    process.stderr.write(`gantry: ${err.message}\n`);
    return EXIT_NOT_A_REPO;
  }
  process.stderr.write(`gantry: ${err instanceof Error ? err.message : String(err)}\n`);
  return EXIT_ERROR;
}

export function summaryLines(r: IndexResult, dataDir: string): string[] {
  return [
    `Indexed ${r.files} files in ${r.ms} ms`,
    `  symbols:       ${r.symbols}`,
    `  function-like: ${r.functionLike}`,
    `  edges:         ${r.edges}`,
    `  unresolved:    ${r.unresolved.length}`,
    `  parse errors:  ${r.parseErrors.length}`,
    `  data:          ${dataDir}`,
  ];
}

/** Writes to stdout, ignoring EPIPE so `| head` does not crash the process. */
export function writeStdout(text: string): void {
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "EPIPE") throw e;
  });
  process.stdout.write(text);
}

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

/**
 * stdout carries protocol frames only (spec section 1). Anything that would print there (a stray `console.log` in a
 * handler or a dependency) goes to stderr instead. Call before anything else when the process starts.
 */
export function redirectConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${format(...args)}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

export interface Logger {
  error(message: string, err?: unknown): void;
  info(message: string): void;
}

const describeError = (err: unknown): string =>
  err instanceof Error ? (err.stack ?? err.message) : String(err);

/** Logs to stderr; errors are also appended to `<logsDir>/mcp.log` when a directory is known (best effort). */
export function createLogger(logsDir?: () => string | undefined): Logger {
  const write = (line: string, toFile: boolean): void => {
    process.stderr.write(`gantry-mcp: ${line}\n`);
    if (!toFile) return;
    try {
      const dir = logsDir?.();
      if (!dir) return;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(join(dir, "mcp.log"), `${new Date().toISOString()} ${line}\n`);
    } catch {
      // logging must never break a tool call
    }
  };
  return {
    error: (message, err) => write(err === undefined ? message : `${message}: ${describeError(err)}`, true),
    info: (message) => write(message, false),
  };
}

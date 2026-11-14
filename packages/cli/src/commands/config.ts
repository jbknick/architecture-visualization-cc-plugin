import { ensureDataDir, loadConfig, resolvePaths, saveProjectConfig } from "@gantry/core";
import type { Command } from "commander";
import { EXIT_OK, fail, writeStdout } from "./shared.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keys below these paths are free-form records, so unknown names are allowed there. */
const OPEN_RECORDS = new Set(["workspaces.overrides"]);

function lookup(cfg: unknown, parts: string[]): { found: boolean; value?: unknown } {
  let cur: unknown = cfg;
  for (const p of parts) {
    if (!isObj(cur) || !(p in cur)) return { found: false };
    cur = cur[p];
  }
  return { found: true, value: cur };
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // a bare word such as `timeboxed` is a string
  }
}

/** Turns the schema error carried by saveProjectConfig into one readable line. */
function describe(key: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const start = msg.indexOf("[");
  try {
    const issues = JSON.parse(start >= 0 ? msg.slice(start) : msg) as {
      path?: unknown[];
      message?: string;
    }[];
    const first = issues[0];
    if (first) {
      return new Error(
        `Invalid value for ${(first.path ?? []).join(".") || key}: ${first.message ?? "does not match the config schema"}`,
      );
    }
  } catch {
    // not JSON; fall through
  }
  return new Error(`Invalid value for ${key}: ${msg}`);
}

export function registerConfig(program: Command): void {
  const config = program.command("config").description("Read or write project config (dot.keys)");

  config
    .command("get")
    .description("Print the effective value of a config key (the whole config when no key is given)")
    .argument("[key]", "dot.separated key, e.g. precommit.mode")
    .action((key: string | undefined) => {
      try {
        const paths = resolvePaths(process.cwd());
        const cfg = loadConfig(paths);
        let value: unknown = cfg;
        if (key) {
          const r = lookup(cfg, key.split("."));
          if (!r.found) throw new Error(`Unknown config key: ${key}`);
          value = r.value;
        }
        writeStdout(typeof value === "string" ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });

  config
    .command("set")
    .description("Set a project config key to a JSON value (or a plain string)")
    .argument("<key>", "dot.separated key, e.g. precommit.mode")
    .argument("<value>", "JSON, or a bare string")
    .action((key: string, raw: string) => {
      try {
        const paths = resolvePaths(process.cwd());
        const parts = key.split(".");
        if (parts.some((p) => p === "")) throw new Error(`Invalid config key: ${key}`);
        const leaf = parts[parts.length - 1] as string;
        const parentParts = parts.slice(0, -1);
        const parent = lookup(loadConfig(paths), parentParts);
        const known =
          parent.found &&
          isObj(parent.value) &&
          (leaf in parent.value || OPEN_RECORDS.has(parentParts.join(".")));
        if (!known) throw new Error(`Unknown config key: ${key}`);

        const patch: Obj = {};
        let cur = patch;
        for (const p of parentParts) {
          const next: Obj = {};
          cur[p] = next;
          cur = next;
        }
        cur[leaf] = parseValue(raw);
        ensureDataDir(paths);
        try {
          saveProjectConfig(paths, patch);
        } catch (err) {
          throw describe(key, err);
        }
        process.exitCode = EXIT_OK;
      } catch (err) {
        process.exitCode = fail(err);
      }
    });
}

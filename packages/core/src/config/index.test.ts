import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GantryPaths } from "../paths/index.js";
import { BUILTIN_EXCLUDES, GantryConfigSchema, loadConfig, saveProjectConfig } from "./index.js";

let tmp: string;
let p: GantryPaths;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-config-"));
  p = {
    root: tmp,
    worktreeHash: "0".repeat(16),
    dataDir: path.join(tmp, "data"),
    dbPath: path.join(tmp, "data", "gantry.db"),
    configPath: path.join(tmp, "data", "config.json"),
    catalogDir: path.join(tmp, "data", "catalog"),
    logsDir: path.join(tmp, "data", "logs"),
    globalConfigPath: path.join(tmp, "global.json"),
    shimPath: path.join(tmp, "gantry"),
  };
  fs.mkdirSync(p.dataDir);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("defaults match spec section 5", () => {
  expect(loadConfig(p)).toMatchInlineSnapshot(`
    {
      "backlogReminderThreshold": 100,
      "duplicates": {
        "ignore": [],
        "mode": "warn",
        "thresholds": {
          "codeVector": 0.96,
          "nearJaccard": 0.85,
          "semantic": 0.6,
        },
      },
      "exclude": [],
      "precommit": {
        "budgetMs": 8000,
        "maxFunctions": 50,
        "mode": "off",
      },
      "renameSuggestions": false,
      "routing": {
        "describe.init": {
          "effort": "low",
          "model": "haiku",
        },
        "describe.precommit": {
          "effort": "low",
          "model": "haiku",
        },
        "describe.retry": {
          "effort": "low",
          "model": "sonnet",
        },
        "describe.sync": {
          "effort": "low",
          "model": "haiku",
        },
        "explain": {
          "effort": "medium",
          "model": "sonnet",
        },
        "overview": {
          "effort": "low",
          "model": "sonnet",
        },
      },
      "views": {
        "slices": [
          "apps/*/src/features/*",
          "apps/*/src/modules/*",
          "packages/*",
        ],
      },
      "workspaces": {
        "overrides": {},
      },
    }
  `);
  expect(GantryConfigSchema.safeParse(loadConfig(p)).success).toBe(true);
});

test("layers merge: objects merge, arrays replace", () => {
  fs.writeFileSync(
    p.globalConfigPath,
    JSON.stringify({ precommit: { mode: "strict" }, exclude: ["a", "b"] }),
  );
  fs.writeFileSync(p.configPath, JSON.stringify({ precommit: { budgetMs: 1 }, exclude: ["c"] }));
  const c = loadConfig(p);
  expect(c.precommit).toEqual({ mode: "strict", budgetMs: 1, maxFunctions: 50 });
  expect(c.exclude).toEqual(["c"]);
});

test("invalid project config warns on stderr and falls back to global", () => {
  const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  fs.writeFileSync(p.globalConfigPath, JSON.stringify({ precommit: { mode: "strict" } }));
  fs.writeFileSync(p.configPath, JSON.stringify({ precommit: { mode: "bogus" } }));
  expect(loadConfig(p).precommit.mode).toBe("strict");
  expect(warn).toHaveBeenCalledOnce();
  expect(String(warn.mock.calls[0]?.[0])).toContain(p.configPath);
});

test("unparseable JSON does not throw", () => {
  const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  fs.writeFileSync(p.configPath, "{nope");
  expect(loadConfig(p).precommit.mode).toBe("off");
  expect(warn).toHaveBeenCalled();
});

test("saveProjectConfig merges, persists only the patch, leaves no temp files", () => {
  saveProjectConfig(p, { precommit: { mode: "timeboxed" } });
  const c = saveProjectConfig(p, { exclude: ["x"] });
  expect(c.precommit.mode).toBe("timeboxed");
  expect(JSON.parse(fs.readFileSync(p.configPath, "utf8"))).toEqual({
    precommit: { mode: "timeboxed" },
    exclude: ["x"],
  });
  expect(loadConfig(p)).toEqual(c);
  expect(fs.readdirSync(p.dataDir)).toEqual(["config.json"]);
});

test("saveProjectConfig rejects invalid patch without writing", () => {
  expect(() => saveProjectConfig(p, { precommit: { mode: "nope" as never } })).toThrow();
  expect(fs.existsSync(p.configPath)).toBe(false);
});

test("BUILTIN_EXCLUDES includes spec entries", () => {
  for (const e of ["node_modules", "**/routeTree.gen.ts", ".env*", "*.tfvars", "secrets*"]) {
    expect(BUILTIN_EXCLUDES).toContain(e);
  }
});

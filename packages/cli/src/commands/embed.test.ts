import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A spy in place of the real embedding entry points: the tests prove which command reaches them.
const spies = vi.hoisted(() => ({
  embedPending: vi.fn(),
  getEmbedder: vi.fn(),
}));
vi.mock("@gantry/core", async (orig) => {
  const m = await orig<typeof import("@gantry/core")>();
  return { ...m, embedPending: spies.embedPending, getEmbedder: spies.getEmbedder };
});

import { progressLine, registerEmbed } from "./embed.js";
import { registerInit } from "./init.js";

interface MaterializedFixture {
  dir: string;
  cleanup(): Promise<void>;
}
const helperPath = "../../../core/test/helpers/fixture.js";
const { materializeFixture } = (await import(/* @vite-ignore */ helperPath)) as {
  materializeFixture: (name: string) => Promise<MaterializedFixture>;
};

const result = {
  descriptions: 0,
  code: 0,
  remaining: 0,
  remainingDescriptions: 0,
  remainingCode: 0,
  belowFloor: 0,
  stoppedBy: "complete",
};

let fx: MaterializedFixture;
let data: string;
const cwd = process.cwd();
const oldData = process.env.CLAUDE_PLUGIN_DATA;

beforeEach(async () => {
  spies.embedPending.mockReset().mockResolvedValue(result);
  spies.getEmbedder.mockReset();
  fx = await materializeFixture("single-pkg");
  data = mkdtempSync(join(tmpdir(), "gantry-embed-cli-"));
  process.env.CLAUDE_PLUGIN_DATA = data;
  process.chdir(fx.dir);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(cwd);
  if (oldData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = oldData;
  await fx.cleanup();
  rmSync(data, { recursive: true, force: true });
  process.exitCode = 0;
});

async function run(args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerInit(program);
  registerEmbed(program);
  await program.parseAsync(["node", "gantry", ...args]);
}

describe("gantry init and embedding", () => {
  it("init does not load the model or embed anything", async () => {
    await run(["init"]);
    expect(spies.embedPending).not.toHaveBeenCalled();
    expect(spies.getEmbedder).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("init --embed is the explicit opt-in and runs the shared embed code once", async () => {
    await run(["init", "--embed"]);
    expect(spies.embedPending).toHaveBeenCalledTimes(1);
    expect(spies.embedPending.mock.calls[0]?.[1]).toMatchObject({ root: expect.any(String) });
    expect(process.exitCode).toBe(0);
  });

  it("init --embed never fails the init when embedding throws", async () => {
    spies.embedPending.mockRejectedValue(new Error("no model"));
    await run(["init", "--embed"]);
    expect(process.exitCode).toBe(0);
  });

  it("embed passes --limit and --budget-ms through and prints JSON", async () => {
    await run(["init"]);
    await run(["embed", "--limit", "5", "--budget-ms", "1500", "--json"]);
    expect(spies.embedPending).toHaveBeenCalledTimes(1);
    expect(spies.embedPending.mock.calls[0]?.[1]).toMatchObject({ limit: 5, timeBudgetMs: 1500 });
    const printed = (process.stdout.write as unknown as { mock: { calls: string[][] } }).mock.calls
      .map((c) => c[0])
      .join("");
    expect(JSON.parse(printed.slice(printed.lastIndexOf("{")))).toMatchObject({ remaining: 0 });
  });

  it("embed rejects a bad --limit", async () => {
    await run(["embed", "--limit", "nope"]);
    expect(spies.embedPending).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe("progressLine", () => {
  it("prints done/total, the rate and the minutes left", () => {
    const line = progressLine({
      phase: "code",
      done: 320,
      total: 3511,
      phaseDone: 320,
      phaseTotal: 3511,
      elapsedMs: 500_000,
      phaseElapsedMs: 457_000,
    });
    expect(line).toBe("embedded 320/3,511 code, 42/min, about 76 min left");
  });

  it("prints only the counts before any time has passed", () => {
    expect(
      progressLine({
        phase: "descriptions",
        done: 0,
        total: 9,
        phaseDone: 0,
        phaseTotal: 9,
        elapsedMs: 0,
        phaseElapsedMs: 0,
      }),
    ).toBe("embedded 0/9 descriptions");
  });
});

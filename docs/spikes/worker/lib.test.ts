import { describe, expect, it } from "vitest";
import {
  buildArgs,
  makeFactSheets,
  median,
  parseInit,
  parseRun,
  RESULTS_SCHEMA,
  renderFactSheets,
  shellQuote,
  validateResults,
} from "./lib.js";

const base = { model: "haiku", effort: "low", systemPromptFile: "/tmp/p.txt", schema: RESULTS_SCHEMA };

describe("buildArgs", () => {
  it("emits the full spec section 16 recipe", () => {
    const a = buildArgs(base);
    for (const f of [
      "-p",
      "--safe-mode",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--system-prompt-file",
      "--json-schema",
    ]) {
      expect(a).toContain(f);
    }
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a[a.indexOf("--disallowedTools") + 1]).toBe("mcp__*");
    expect(a[a.indexOf("--output-format") + 1]).toBe("json");
  });
  it("drops exactly the requested flags", () => {
    const a = buildArgs({ ...base, drop: new Set(["safe-mode", "json-schema"]) });
    expect(a).not.toContain("--safe-mode");
    expect(a).not.toContain("--json-schema");
    expect(a).toContain("--strict-mcp-config");
  });
  it("adds --verbose for stream-json", () => {
    expect(buildArgs({ ...base, outputFormat: "stream-json" })).toContain("--verbose");
  });
  it("quotes empty args for printing", () => {
    expect(shellQuote(["--tools", "", "mcp__*"])).toBe("--tools '' 'mcp__*'");
  });
});

describe("makeFactSheets", () => {
  it("is deterministic with unique keys and renamed variants", () => {
    const a = makeFactSheets(40);
    expect(a).toEqual(makeFactSheets(40));
    expect(new Set(a.map((s) => s.contentKey)).size).toBe(40);
    expect(a[3]?.name).toBe("clampPercentV1");
    expect(a[3]?.text).toContain("name: clampPercentV1");
    expect(renderFactSheets(a.slice(0, 2))).toContain("=== FACT SHEET spike001:p1 ===");
  });
});

describe("parseRun", () => {
  it("reads structured_output and usage", () => {
    const out = JSON.stringify({
      is_error: false,
      structured_output: { results: [] },
      usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 2 },
      total_cost_usd: 0.001,
    });
    const r = parseRun(out, "", false);
    expect(r.outcome).toBe("ok");
    expect(r.usage).toMatchObject({ inputTokens: 5, outputTokens: 7, cacheReadTokens: 2 });
  });
  it("flags a missing structured_output", () => {
    expect(parseRun(JSON.stringify({ is_error: false, result: "hi" }), "", false).outcome).toBe(
      "no_structured_output",
    );
  });
  it("detects not-logged-in", () => {
    const out = JSON.stringify({ is_error: true, result: "Not logged in · Please run /login" });
    expect(parseRun(out, "", false).outcome).toBe("not_logged_in");
  });
  it("detects flag errors, timeouts and junk", () => {
    expect(parseRun("", "error: unknown option '--x'", false).outcome).toBe("flag_error");
    expect(parseRun("", "", true).outcome).toBe("timeout");
    expect(parseRun("not json", "", false).outcome).toBe("unparseable");
  });
});

describe("validateResults", () => {
  const good = {
    results: [
      {
        content_key: "k1",
        description: { behavior: "Clamps a number.", searchTerms: ["clamp"], nameFits: true },
      },
    ],
  };
  it("accepts a valid result", () => {
    expect(validateResults(good, ["k1"]).ok).toBe(true);
  });
  it("reports missing keys, long behavior and bad suggestedName", () => {
    const bad = {
      results: [
        {
          content_key: "k1",
          description: { behavior: "x ".repeat(30), searchTerms: [], nameFits: false, suggestedName: "1bad" },
        },
      ],
    };
    const v = validateResults(bad, ["k1", "k2"]);
    const all = v.problems.join("|");
    expect(v.ok).toBe(false);
    expect(all).toMatch(/over 25 words/);
    expect(all).toMatch(/searchTerms count/);
    expect(all).toMatch(/suggestedName invalid/);
    expect(all).toMatch(/k2: missing/);
  });
});

describe("median and parseInit", () => {
  it("computes medians", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
  it("reads the init event", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      tools: ["StructuredOutput"],
      mcp_servers: [{ name: "a" }],
      skills: ["s"],
      slash_commands: ["c", "d"],
      plugins: [{ name: "p" }],
      agents: ["x"],
    });
    expect(parseInit(`noise\n${line}\n`)).toEqual({
      tools: ["StructuredOutput"],
      mcpServers: ["a"],
      skills: 1,
      slashCommands: 2,
      plugins: ["p"],
      agents: ["x"],
    });
    expect(parseInit("nothing")).toBeUndefined();
  });
});

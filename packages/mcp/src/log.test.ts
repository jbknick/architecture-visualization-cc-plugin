import { afterEach, describe, expect, it, vi } from "vitest";
import { redirectConsoleToStderr } from "./log.js";

const saved = { log: console.log, info: console.info, debug: console.debug };
afterEach(() => {
  Object.assign(console, saved);
  vi.restoreAllMocks();
});

describe("redirectConsoleToStderr", () => {
  it("sends console.log, info and debug to stderr and nothing to stdout", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    redirectConsoleToStderr();
    console.log("from a handler");
    console.info("info");
    console.debug("debug");
    expect(out).not.toHaveBeenCalled();
    const written = err.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("from a handler");
    expect(written).toContain("info");
    expect(written).toContain("debug");
  });

  it("covers a console.log inside a tool handler of a running server", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    redirectConsoleToStderr();
    const { call, connect, makeRepo } = await import("./testkit.js");
    const { defineTool } = await import("./tool.js");
    const noisy = defineTool({
      name: "noisy",
      description: "Logs.",
      inputSchema: {},
      run() {
        console.log("handler wrote this");
        return { ok: true };
      },
    });
    const repo = makeRepo();
    const conn = await connect(repo, { tools: [noisy] });
    try {
      expect((await call(conn.client, "noisy")).json).toEqual({ ok: true });
      expect(out.mock.calls.map((c) => String(c[0])).join("")).not.toContain("handler wrote this");
      expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("handler wrote this");
    } finally {
      await conn.close();
      repo.cleanup();
    }
  });
});

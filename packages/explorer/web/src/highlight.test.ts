import { describe, expect, it } from "vitest";
import { tokenize, tokenizeLines } from "./highlight.ts";

describe("tokenize", () => {
  it("classifies keywords, strings, numbers, types and comments", () => {
    const tokens = tokenize('const x: Foo = "a" + 42; // note');
    const byType = (t: string) => tokens.filter((k) => k.type === t).map((k) => k.text);
    expect(byType("keyword")).toEqual(["const"]);
    expect(byType("string")).toEqual(['"a"']);
    expect(byType("number")).toEqual(["42"]);
    expect(byType("type")).toEqual(["Foo"]);
    expect(byType("comment")).toEqual(["// note"]);
  });

  it("is lossless", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the sample source contains a template literal
    const src = "export function f(a: number) {\n  return `x${a}`; /* c */\n}\n";
    expect(
      tokenize(src)
        .map((t) => t.text)
        .join(""),
    ).toBe(src);
  });

  it("handles unterminated strings and comments without hanging", () => {
    expect(
      tokenize('"abc')
        .map((t) => t.text)
        .join(""),
    ).toBe('"abc');
    expect(
      tokenize("/* open")
        .map((t) => t.text)
        .join(""),
    ).toBe("/* open");
  });

  it("never turns markup into anything but text", () => {
    const tokens = tokenize("<img src=x onerror=alert(1)>");
    expect(tokens.map((t) => t.text).join("")).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("tokenizeLines", () => {
  it("splits multi-line tokens across lines", () => {
    const lines = tokenizeLines(["/* a", "b */ x"]);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.[0]).toEqual({ type: "comment", text: "/* a" });
    expect(lines[1]?.[0]).toEqual({ type: "comment", text: "b */" });
  });
});

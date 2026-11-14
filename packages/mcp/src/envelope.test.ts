import { describe, expect, it } from "vitest";
import { envelope, errorEnvelope, fitJson, MAX_RESPONSE_CHARS } from "./envelope.js";

describe("envelope", () => {
  it("is one text block holding the JSON", () => {
    const r = envelope({ a: 1, b: ["x"] });
    expect(r.content).toEqual([{ type: "text", text: '{"a":1,"b":["x"]}' }]);
    expect(r.isError).toBeUndefined();
  });

  it("marks errors with isError and { error, message }", () => {
    const r = errorEnvelope("boom", "it broke");
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]?.text as string)).toEqual({ error: "boom", message: "it broke" });
  });

  it("trims arrays from the end and says so", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i, text: "y".repeat(100) }));
    const text = fitJson({ items, kept: "me" });
    expect(text.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    const out = JSON.parse(text) as { items: { id: number }[]; truncated: boolean; kept: string };
    expect(out.truncated).toBe(true);
    expect(out.kept).toBe("me");
    expect(out.items.length).toBeGreaterThan(0);
    expect(out.items.length).toBeLessThan(100);
    expect(out.items.map((i) => i.id)).toEqual(items.slice(0, out.items.length).map((i) => i.id));
  });

  it("trims the largest array first, including nested ones", () => {
    const big = Array.from({ length: 80 }, () => "z".repeat(100));
    const out = JSON.parse(fitJson({ small: ["a", "b"], deep: { list: big } })) as {
      small: string[];
      deep: { list: string[] };
    };
    expect(out.small).toEqual(["a", "b"]);
    expect(out.deep.list.length).toBeLessThan(80);
  });

  it("does not add truncated when nothing was cut, and does not modify the input", () => {
    const input = { items: ["a"] };
    expect(JSON.parse(fitJson(input))).toEqual({ items: ["a"] });
    const big = { items: Array.from({ length: 200 }, () => "q".repeat(50)) };
    fitJson(big);
    expect(big.items).toHaveLength(200);
  });

  it("answers with an error payload when no array can be trimmed", () => {
    const out = JSON.parse(fitJson({ text: "w".repeat(5000) })) as { error: string; truncated: boolean };
    expect(out).toMatchObject({ error: "response_too_large", truncated: true });
    expect(fitJson({ text: "w".repeat(5000) }).length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
  });
});

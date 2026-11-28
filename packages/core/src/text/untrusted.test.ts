import { describe, expect, it } from "vitest";
import { cleanUntrustedText, hasHiddenText, stripHiddenText } from "./untrusted.js";

const cp = (...n: number[]) => String.fromCodePoint(...n);

describe("untrusted text", () => {
  it("keeps emoji sequences and Persian and Indic words with a joiner between visible characters", () => {
    for (const s of ["👩‍💻 Devs", "می‌خواهم", "क्‍ष", "❤️‍🔥", "🇫🇷 France", "Café 支付服务"]) {
      expect(stripHiddenText(s)).toBe(s);
      expect(hasHiddenText(s)).toBe(false);
    }
  });

  it("strips a joiner with no visible character on both sides", () => {
    expect(stripHiddenText("‍a")).toBe("a");
    expect(stripHiddenText("a‍")).toBe("a");
    expect(stripHiddenText("a ‍ b")).toBe("a b");
    expect(stripHiddenText("a‌‌b")).toBe("ab");
    expect(stripHiddenText("a‍‍b")).toBe("ab");
    expect(hasHiddenText("a‍")).toBe(true);
    expect(hasHiddenText("‌b")).toBe(true);
  });

  it("strips the variation selectors of the supplement, however many follow a visible name", () => {
    const run = cp(...Array.from({ length: 40 }, (_, i) => 0xe0100 + i));
    expect(stripHiddenText(`Orders${run}`)).toBe("Orders");
    expect(hasHiddenText(`Orders${run}`)).toBe(true);
    expect(stripHiddenText(`a${cp(0xe01ef)}b`)).toBe("ab");
  });

  it("keeps one FE00 to FE0F straight after a visible character and strips every other", () => {
    expect(stripHiddenText("❤️ core")).toBe("❤️ core");
    expect(stripHiddenText("a️️️b")).toBe("a️b");
    expect(stripHiddenText("a︀️b")).toBe("a︀b");
    expect(stripHiddenText("️a")).toBe("a");
    expect(stripHiddenText("a ️b")).toBe("a b");
    expect(stripHiddenText("a᠋b᠌c᠍d")).toBe("abcd");
  });

  it("strips the characters that draw nothing", () => {
    for (const c of [0x034f, 0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0x17b4, 0x17b5]) {
      expect(stripHiddenText(`a${cp(c)}b`), c.toString(16)).toBe("ab");
      expect(hasHiddenText(cp(c))).toBe(true);
    }
    expect(stripHiddenText("⠀ㅤ")).toBe("");
  });

  it("still strips zero-width, bidi, tag, private-use and lone-surrogate characters and turns spaces into one", () => {
    expect(stripHiddenText("a​‮⁦﻿­b")).toBe("ab");
    expect(stripHiddenText(`a${cp(0xe0069, 0xe0067)}\ud800b`)).toBe("ab");
    expect(stripHiddenText("a\n\r  　b")).toBe("a b");
    expect(hasHiddenText("a\nb")).toBe(true);
    expect(hasHiddenText("a b")).toBe(false);
  });

  it("cuts and replaces backticks", () => {
    expect(cleanUntrustedText("a`b", 80)).toBe("a'b");
    expect(cleanUntrustedText("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

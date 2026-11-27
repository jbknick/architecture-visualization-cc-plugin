import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const hooksDir = join(here, "..", "hooks");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/** No hook waits on the network, so no hook may reach the team client. */
describe("hooks never use the team client", () => {
  const files = [...sources(hooksDir), join(here, "hook.ts"), join(here, "hooks.ts")].filter(
    (f) => !f.endsWith(".test.ts"),
  );

  it("finds the hook sources", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    it(`${relative(join(here, "..", ".."), file)} does not import team/client, pullTeamCache or the publish functions`, () => {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/team\/client/);
      expect(text).not.toMatch(/\bteamClient\b/);
      expect(text).not.toMatch(/\bpullTeamCache\b/); // hooks may import only the cache readers
      expect(text).not.toMatch(/\b(?:un)?publish(?:View|Group)\b/); // publishing is `gantry team publish` only
    });
  }
});

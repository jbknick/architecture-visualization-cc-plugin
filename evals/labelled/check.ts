/**
 * Validates the private labelled set against the contract in issue #5 and spec sections 7 and 8.
 *
 * Usage: pnpm tsx evals/labelled/check.ts [path]   (default evals/private/labelled/devprentice.jsonl)
 * Prints `200 valid` on success; exits 1 with the problems otherwise. Prints counts only, never content.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(process.argv[2] ?? join(here, "..", "private", "labelled", "devprentice.jsonl"));

const EXPECTED: Record<string, number> = { component: 40, hook: 30, util: 50, server: 40, helper: 40 };
const IDENT = /^[A-Za-z_$][\w$]*$/;

const FactSheet = z.object({
  contentKey: z.string().min(1),
  id: z.string().startsWith("sym:"),
  path: z.string().min(1),
  kind: z.enum(["function", "method", "component", "hook", "class", "type", "interface", "enum", "const"]),
  signature: z.string(),
  doc: z.string().nullable(),
  callees: z.array(z.string()),
  returnType: z.string().nullable(),
  body: z.string().max(1500),
});

const Label = z
  .object({
    behavior: z
      .string()
      .min(1)
      .max(200)
      .refine((s) => s.trim().split(/\s+/).length <= 25, "behavior over 25 words"),
    nameFits: z.boolean(),
    suggestedName: z.string().regex(IDENT).optional(),
  })
  .refine((l) => (l.nameFits ? l.suggestedName === undefined : l.suggestedName !== undefined), {
    message: "suggestedName required iff nameFits is false",
  });

const Row = z
  .object({
    id: z.string().startsWith("sym:"),
    factSheet: FactSheet,
    label: Label,
    stratum: z.enum(["component", "hook", "util", "server", "helper"]),
  })
  .refine((r) => r.id === r.factSheet.id, { message: "id differs from factSheet.id" });

function main(): void {
  if (!existsSync(file)) {
    console.error(`missing ${file}`);
    process.exit(1);
  }
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const problems: string[] = [];
  const counts: Record<string, number> = {};
  const ids = new Set<string>();
  let valid = 0;
  lines.forEach((line, i) => {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      problems.push(`line ${i + 1}: invalid JSON`);
      return;
    }
    const r = Row.safeParse(json);
    if (!r.success) {
      problems.push(
        `line ${i + 1}: ${r.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`,
      );
      return;
    }
    if (ids.has(r.data.id)) problems.push(`line ${i + 1}: duplicate id`);
    ids.add(r.data.id);
    counts[r.data.stratum] = (counts[r.data.stratum] ?? 0) + 1;
    valid++;
  });
  if (lines.length !== 200) problems.push(`expected 200 lines, found ${lines.length}`);
  for (const [s, n] of Object.entries(EXPECTED))
    if ((counts[s] ?? 0) !== n) problems.push(`stratum ${s}: expected ${n}, found ${counts[s] ?? 0}`);
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  console.log(`${valid} valid`);
}

main();

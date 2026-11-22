// Shared code of the OSS evaluation corpus (spec section 13): the repos.json schema and where clones live.
// No network, no git.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const reposPath = join(repoRoot, "evals/oss/repos.json");

const sha = z.string().regex(/^[0-9a-f]{40}$/, "sha must be 40 lowercase hex characters");

const repoSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9._-]+$/, "name must match [a-z0-9._-]+"),
  url: z
    .string()
    .refine((u) => u.startsWith("https://") || u.startsWith("file://"), "url must be https or file://"),
  sha,
  stack: z.array(z.string().regex(/^[^A-Z\s]+$/, "stack entries are lowercase")).min(1),
  lang: z.array(z.enum(["ts", "go"])),
  role: z.enum(["tuning", "held-out"]),
});

export const reposSchema = z.strictObject({ repos: z.array(repoSchema) }).superRefine(({ repos }, ctx) => {
  const seen = new Set<string>();
  repos.forEach((r, i) => {
    if (seen.has(r.name))
      ctx.addIssue({ code: "custom", message: `duplicate name ${r.name}`, path: ["repos", i] });
    seen.add(r.name);
    const prev = repos[i - 1];
    if (prev && prev.name > r.name)
      ctx.addIssue({ code: "custom", message: "entries must be sorted by name", path: ["repos", i] });
  });
});
export type Repo = z.infer<typeof repoSchema>;

export class InputError extends Error {}

export function readJson<T>(path: string, schema: z.ZodType<T>, what: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new InputError(`${what} ${path}: ${(err as Error).message}`);
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new InputError(`${what} ${path} is invalid: ${issues}`);
  }
  return r.data;
}

export const readRepos = (path = reposPath) => readJson(path, reposSchema, "repos file").repos;

/** Where clones live, outside this repository. */
export const ossDir = () => process.env.GANTRY_OSS_DIR || join(homedir(), "Dev", "gantry-oss");
export const targetDir = (r: Repo, base = ossDir()) => join(base, `${r.name}@${r.sha.slice(0, 7)}`);

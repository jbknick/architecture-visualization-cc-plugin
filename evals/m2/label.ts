/**
 * Labels the alerts of the replay (issue #32, step 2) with the headless worker on Sonnet and a fixed rubric, then
 * picks 20 for the operator to spot-check. Every distinct alert at the LOOSE thresholds of the replay is labelled
 * once, so the sweep can score any threshold pair. The prompt carries private code to the model (approved for this
 * issue); results go only to `$GANTRY_PRIVATE_DIR/m2/`: `labels.json` (key to true/false), `label-detail.jsonl`
 * (key, verdict, one-line reason), Prints aggregate counts. The operator's spot-check sample is drawn by `spotcheck.ts`.
 *
 * Usage: GANTRY_PRIVATE_DIR=... CLAUDE_PLUGIN_DATA=<data dir> pnpm tsx evals/m2/label.ts <clone>
 * <clone> only supplies git history (`git show <commit>^:<path>`); it is not modified.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { git, privateDir, writePrivate } from "./lib.js";
import { requireDataDir } from "./safety.js";
import { type Cand, dupKey, importKey, loadEdits } from "./sweep.js";

const repo = resolve(process.argv[2] ?? "");
requireDataDir();
const claudeBin = process.env.CLAUDE_CODE_EXECPATH ?? join(homedir(), ".local", "bin", "claude");

const RUBRIC = `You label alerts from a code-reuse guard. Each item is one alert shown to a developer who just edited a file.

Duplicate alert: the developer's NEW function (as written in the edit) was flagged as looking like an EXISTING function in the repository. Verdict "true" when a careful reviewer would say the new function does substantially the same job as the existing one, so the developer should have reused or imported it (a clone, a near clone, a re-implementation of the same behaviour). Verdict "false" when they do different jobs, when the similarity is only boilerplate, framework scaffolding, type plumbing or a generic shape (for example both are thin wrappers, both return a constant object, both are React components with different content), or when the two are two versions of one thing that is being moved or renamed in the same change (the old copy is the thing being replaced).

Import alert: the guard claims a newly added import names a package the workspace does not declare (or a deep import past its exports map). Verdict "true" when the shown package.json really does not declare that package (and it is not a node built-in, a path alias or a workspace file); otherwise "false".

Be strict about "true": when unsure, answer "false". Answer with JSON only, following the schema: one entry per item, same id, verdict true or false, reason of at most 12 words.`;

const SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, verdict: { type: "boolean" }, reason: { type: "string" } },
        required: ["id", "verdict", "reason"],
      },
    },
  },
  required: ["results"],
};

function sliceLines(text: string, start: number, end: number): string {
  return text
    .split("\n")
    .slice(start - 1, end)
    .join("\n")
    .slice(0, 2500);
}
function showOr(rev: string, rel: string): string {
  try {
    return git(repo, ["show", `${rev}:${rel}`]);
  } catch {
    return "";
  }
}
function symLoc(id: string): { path: string; name: string } {
  const [p, n] = id.replace(/^sym:/, "").split("#");
  return { path: p ?? "", name: n ?? "" };
}
/** Source of a symbol in a file version: from its declaration line, up to 60 lines. */
function symbolText(src: string, name: string, hintLine?: number): string {
  const lines = src.split("\n");
  const base = name.split(".").pop() ?? name;
  const re = new RegExp(`(function\\s+${base}\\b|(const|let)\\s+${base}\\b|\\b${base}\\s*\\()`);
  let i = hintLine && hintLine > 0 ? hintLine - 1 : lines.findIndex((l) => re.test(l));
  if (i < 0) i = 0;
  return lines
    .slice(i, i + 60)
    .join("\n")
    .slice(0, 2500);
}

interface Item {
  key: string;
  prompt: string;
}
const edits = loadEdits();
const items = new Map<string, Item>();
for (const e of edits) {
  const newText = showOr(e.commit, e.path);
  for (const c of e.cands as Cand[]) {
    const k = dupKey(e, c);
    if (items.has(k)) continue;
    const m = symLoc(c.match);
    const oldText = showOr(`${e.commit}^`, m.path);
    items.set(k, {
      key: k,
      prompt: `Duplicate alert [${c.tier} ${c.score.toFixed(2)}]\nNEW (${e.path}, edit):\n${symbolText(newText, symLoc(c.sym).name, c.line)}\n\nEXISTING (${m.path}):\n${symbolText(oldText, m.name)}`,
    });
  }
  for (const i of e.imports) {
    const k = importKey(e, i);
    if (items.has(k)) continue;
    const dir = e.path.split("/");
    let pkg = "";
    while (dir.length > 0) {
      dir.pop();
      const cand = [...dir, "package.json"].join("/");
      const t = showOr(`${e.commit}^`, cand);
      if (t) {
        pkg = `${cand}:\n${t.slice(0, 3000)}`;
        break;
      }
    }
    items.set(k, {
      key: k,
      prompt: `Import alert: "${i.action}"\nFile ${e.path} line ${i.line}: ${sliceLines(newText, i.line, i.line)}\nNearest package.json at the parent commit:\n${pkg || "(none)"}`,
    });
  }
}

const labelsFile = join(privateDir(), "labels.json");
const labels: Record<string, boolean> = existsSync(labelsFile)
  ? JSON.parse(readFileSync(labelsFile, "utf8"))
  : {};
const detail = join(privateDir(), "label-detail.jsonl");
const todo = [...items.values()].filter((i) => labels[i.key] === undefined);
const SYSTEM = join(privateDir(), "label-system.txt");
writeFileSync(SYSTEM, RUBRIC);

function call(
  batch: Item[],
): Promise<{ results: { id: string; verdict: boolean; reason: string }[]; inTok: number; outTok: number }> {
  const input = batch.map((b, j) => `=== ITEM ${j} ===\n${b.prompt}`).join("\n\n");
  return new Promise((res) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GANTRY_WORKER: "1" };
    delete env.CLAUDE_CODE_EFFORT_LEVEL;
    const p = spawn(
      claudeBin,
      [
        "-p",
        "--model",
        "sonnet",
        "--effort",
        "low",
        "--safe-mode",
        "--tools",
        "",
        "--disallowedTools",
        "mcp__*",
        "--strict-mcp-config",
        "--system-prompt-file",
        SYSTEM,
        "--no-session-persistence",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(SCHEMA),
      ],
      { env, cwd: process.env.TMPDIR ?? "/tmp", stdio: ["pipe", "pipe", "ignore"] },
    );
    let out = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.on("close", () => {
      try {
        const j = JSON.parse(out) as {
          structured_output?: { results?: { id: string; verdict: boolean; reason: string }[] };
          usage?: Record<string, number>;
        };
        const u = j.usage ?? {};
        res({
          results: j.structured_output?.results ?? [],
          inTok:
            (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          outTok: u.output_tokens ?? 0,
        });
      } catch {
        res({ results: [], inTok: 0, outTok: 0 });
      }
    });
    p.stdin.end(input);
  });
}

const BATCH = 8;
let inTok = 0;
let outTok = 0;
let calls = 0;
const queue: Item[][] = [];
for (let i = 0; i < todo.length; i += BATCH) queue.push(todo.slice(i, i + BATCH));
async function lane(): Promise<void> {
  for (let b = queue.shift(); b; b = queue.shift()) {
    // ids in the answer are the item numbers as strings
    const r = await call(b);
    calls++;
    inTok += r.inTok;
    outTok += r.outTok;
    for (const x of r.results) {
      const item = b[Number(x.id.replace(/\D/g, ""))];
      if (!item) continue;
      labels[item.key] = x.verdict;
      writeFileSync(detail, `${JSON.stringify({ key: item.key, verdict: x.verdict, reason: x.reason })}\n`, {
        flag: "a",
      });
    }
    writePrivate("labels.json", labels);
    process.stderr.write(`labelled ${Object.keys(labels).length}/${items.size}\n`);
  }
}
await Promise.all([lane(), lane(), lane()]);

// usage of the labelling calls, accumulated across resumed runs (the headless calls are not in the copy's usage_log)
{
  const f = join(privateDir(), "label-usage.json");
  const prev = existsSync(f)
    ? (JSON.parse(readFileSync(f, "utf8")) as { calls: number; inTok: number; outTok: number })
    : { calls: 0, inTok: 0, outTok: 0 };
  writePrivate("label-usage.json", {
    calls: prev.calls + calls,
    inTok: prev.inTok + inTok,
    outTok: prev.outTok + outTok,
  });
}

const keys = Object.keys(labels);
process.stdout.write(
  `${JSON.stringify({ alertsLabelled: keys.length, true: keys.filter((k) => labels[k]).length, false: keys.filter((k) => !labels[k]).length, calls, inTok, outTok })}\n`,
);

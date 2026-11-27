// The shape of action/action.yml that the upload step depends on. No YAML parser is an approved dependency, so the
// file is read as text: a step starts at a line `    - name:` and its environment is the `      env:` block.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** A workflow expression, built here so the lint rule on template placeholders in plain strings stays quiet. */
const expr = (inner: string): string => `\${{ ${inner} }}`;

const yml = readFileSync(join(import.meta.dirname, "../action.yml"), "utf8");

interface Step {
  name: string;
  id: string;
  if: string;
  env: Map<string, string>;
  run: string;
}

function steps(): Step[] {
  const body = yml.slice(yml.indexOf("\n  steps:\n") + "\n  steps:\n".length);
  const out: Step[] = [];
  for (const chunk of body.split(/\n(?= {4}- name: )/)) {
    const lines = chunk.split("\n");
    const field = (key: string): string => {
      const prefix = key === "name" ? "    - name: " : `      ${key}: `;
      return lines.find((l) => l.startsWith(prefix))?.slice(prefix.length) ?? "";
    };
    const env = new Map<string, string>();
    const at = lines.indexOf("      env:");
    if (at !== -1) {
      for (const l of lines.slice(at + 1)) {
        const m = /^ {8}([A-Z_]+): (.*)$/.exec(l);
        if (m) env.set(m[1] as string, m[2] as string);
        else if (!/^ {8}#|^\s*$/.test(l)) break;
      }
    }
    out.push({ name: field("name"), id: field("id"), if: field("if"), env, run: field("run") });
  }
  return out;
}

const step = (id: string): Step => {
  const s = steps().find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};

describe("action.yml", () => {
  it("has the three team inputs, all optional with an empty default", () => {
    for (const name of ["team-server", "team-org", "team-token"]) {
      const at = yml.indexOf(`\n  ${name}:\n`);
      expect(at, name).toBeGreaterThan(-1);
      const block = yml.slice(at, yml.indexOf("\n\n", at) === -1 ? undefined : yml.indexOf("\n\n", at));
      expect(block).toContain("required: false");
      expect(block).toContain('default: ""');
    }
    expect(yml.match(/^ {2}(team-server|team-org|team-token):/gm)).toHaveLength(3);
  });

  it("runs the upload step after the comment step, only with all three inputs set", () => {
    const all = steps().map((s) => s.id);
    expect(all.indexOf("upload")).toBeGreaterThan(all.indexOf("comment"));
    expect(step("upload").if).toBe(
      expr(
        "!cancelled() && inputs.team-server != '' && inputs.team-org != '' && inputs.team-token != '' && steps.install.outputs.failed == ''",
      ),
    );
    expect(step("upload").name).toBe("Upload to the team server");
  });

  it("gives the upload step the settled environment, and reads event values only from the environment", () => {
    const s = step("upload");
    expect([...s.env.keys()].sort()).toEqual(
      [
        "CLAUDE_PLUGIN_DATA",
        "GANTRY_DEFAULT_BRANCH",
        "GANTRY_EVENT",
        "GANTRY_EVENT_ACTION",
        "GANTRY_HEAD_REPO",
        "GANTRY_HOME",
        "GANTRY_INDEX_FAILED",
        "GANTRY_ORG",
        "GANTRY_PR",
        "GANTRY_PR_BASE_BRANCH",
        "GANTRY_PR_BASE_SHA",
        "GANTRY_PR_CREATED_AT",
        "GANTRY_PR_HEAD_REF",
        "GANTRY_PR_HEAD_SHA",
        "GANTRY_PR_MERGED",
        "GANTRY_PR_OWNER",
        "GANTRY_PR_TITLE",
        "GANTRY_REF_NAME",
        "GANTRY_SERVER",
        "GANTRY_TOKEN",
      ].sort(),
    );
    expect(s.env.get("GANTRY_SERVER")).toBe(expr("inputs.team-server"));
    expect(s.env.get("GANTRY_ORG")).toBe(expr("inputs.team-org"));
    expect(s.env.get("GANTRY_TOKEN")).toBe(expr("inputs.team-token"));
    expect(s.env.get("GANTRY_INDEX_FAILED")).toBe(expr("steps.index.outputs.failed"));
    expect(s.env.get("GANTRY_PR_MERGED")).toBe(expr("github.event.pull_request.merged"));
    expect(s.run).toBe('node "$GANTRY_HOME/dist/upload.js"');
    expect(s.run).not.toContain(expr("").slice(0, 3));
  });

  it("keeps the GitHub token in the comment step's GANTRY_TOKEN", () => {
    expect(step("comment").env.get("GANTRY_TOKEN")).toBe(expr("inputs.github-token"));
    expect(step("comment").env.get("GANTRY_TOKEN")).not.toContain("team-token");
  });

  it("skips the index, embed and comment steps on a closed pull request, and the install step stays", () => {
    for (const id of ["index", "embed", "comment"]) {
      expect(step(id).if, id).toContain("github.event.action != 'closed'");
    }
    expect(step("install").if).toBe("");
    expect(step("upload").if).not.toContain("closed");
  });

  it("never uses pull_request_target", () => {
    expect(yml).not.toContain("pull_request_target");
  });

  describe("which steps run for an event", () => {
    // Evaluates the `if` of a step for a context. Only what action.yml uses: contexts, ==, !=, &&, ||, !, cancelled().
    const runs = (step: Step, ctx: Record<string, string>): boolean => {
      if (step.if === "") return true;
      const code = step.if
        .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
        .replace(/cancelled\(\)/g, "false")
        .replace(/\b(?:inputs|steps|github)\.[A-Za-z0-9_.-]+/g, (path) => JSON.stringify(ctx[path] ?? ""));
      return new Function(`return (${code});`)() as boolean;
    };
    const team = {
      "inputs.team-server": "https://team.example.test",
      "inputs.team-org": "acme",
      "inputs.team-token": "t",
    };
    const ran = (ctx: Record<string, string>): string[] =>
      steps()
        .filter((s) => runs(s, { ...team, ...ctx }))
        .map((s) => s.id || s.name);

    it("a push runs install, index and upload, and not the comment: it has nothing to review", () => {
      const got = ran({ "github.event_name": "push" });
      expect(got).toContain("install");
      expect(got).toContain("index");
      expect(got).toContain("upload");
      expect(got).not.toContain("comment");
      expect(got).not.toContain("embed");
      // every step that runs on a push is one that cannot fail the job: the comment script, which throws without a
      // pull request to review, is not among them
      expect(got.filter((id) => !["install", "index", "upload"].includes(id))).toEqual(["Set up Node 26"]);
    });

    it("a push with embed set still skips the embed step, which only serves the comment", () => {
      expect(ran({ "github.event_name": "push", "inputs.embed": "true" })).not.toContain("embed");
    });

    it("a pull request update runs every step", () => {
      const got = ran({
        "github.event_name": "pull_request",
        "github.event.action": "opened",
        "inputs.embed": "true",
      });
      expect(got).toEqual(["Set up Node 26", "install", "index", "embed", "comment", "upload"]);
    });

    it("a closed pull request runs install and upload only", () => {
      const got = ran({
        "github.event_name": "pull_request",
        "github.event.action": "closed",
        "inputs.embed": "true",
      });
      expect(got).toEqual(["Set up Node 26", "install", "upload"]);
    });

    it("a run with base and head inputs set still comments (the summary path)", () => {
      const got = ran({ "github.event_name": "workflow_dispatch", "inputs.base": "a", "inputs.head": "b" });
      expect(got).toContain("comment");
    });
  });
});

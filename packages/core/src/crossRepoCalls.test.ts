import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dumpGraph, indexRepo } from "./indexer.js";
import { type GantryPaths, resolvePaths } from "./paths/index.js";
import { openStore } from "./store/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const git = (cwd: string, args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "ignore" });
};

/** Copies fixture directories into temp git repos, writes the workspace file listing them, and returns each repo's paths. */
function workspaceOf(fixture: string, names: Record<string, string>, prepare?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "gantry-crossrepo-"));
  const data = mkdtempSync(join(tmpdir(), "gantry-crossrepo-data-"));
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });
  const repos = Object.entries(names).map(([dir, repo]) => ({ path: `./${dir}`, repo }));
  for (const dir of Object.keys(names))
    cpSync(join(fixtures, fixture, dir), join(root, dir), { recursive: true });
  prepare?.(root);
  for (const dir of Object.keys(names)) {
    git(join(root, dir), ["init", "-q", "-b", "main"]);
    git(join(root, dir), ["add", "-A", "-f"]);
    git(join(root, dir), [
      "-c",
      "user.name=f",
      "-c",
      "user.email=f@example.invalid",
      "commit",
      "-q",
      "-m",
      "fixture",
    ]);
  }
  writeFileSync(join(root, "gantry-workspace.json"), JSON.stringify({ repos }));
  const env = { HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data };
  const paths = (dir: string): GantryPaths => resolvePaths(join(root, dir), env);
  return { root, paths };
}

type Dump = ReturnType<typeof dumpGraph>;
type Edge = { src: string; dst: string; kind: string; fileId: string; confidence: string };
type Node = { id: string; kind: string; label: string; data: Record<string, unknown> };

function dump(paths: GantryPaths): Dump {
  const s = openStore(paths.dbPath, { repo: paths.repo });
  try {
    return dumpGraph(s);
  } finally {
    s.close();
  }
}
const requests = (d: Dump): Edge[] => (d.edges as Edge[]).filter((e) => e.kind === "requests");
/** Per call site of the web repo's `calls.ts`: what it links to (`->`) or why it does not. */
function outcomes(d: Dump, repo: string): Map<string, string> {
  const out = new Map<string, string>();
  const file = `file:${repo}:src/calls.ts`;
  for (const e of requests(d)) if (e.fileId === file) out.set(e.src, `-> ${e.dst} (${e.confidence})`);
  for (const n of (d.adapterNodes ?? []) as Node[]) {
    if (n.kind !== "client_call" || n.data.file !== "src/calls.ts") continue;
    const cands = n.data.candidates ? ` [${(n.data.candidates as string[]).join(", ")}]` : "";
    out.set(`${n.data.caller}`, `${n.data.reason}: ${n.label}${cands}`);
  }
  return out;
}

const NAMES = { web: "web", "users-api": "users-api", billing: "billing" };

describe("cross-repo calls on fixtures/linking-repos", () => {
  it("links each call to the handler of the right repo and leaves the rest as gaps", async () => {
    const { paths } = workspaceOf("linking-repos", NAMES);
    await indexRepo(paths("web"), { layer: "main" });
    const o = outcomes(dump(paths("web")), "web");
    const at = (name: string): string | undefined => o.get(`sym:web:src/calls.ts#${name}`);
    expect(at("listUsers")).toBe("-> ep:users-api:.:GET /api/users (high)");
    expect(at("getUser")).toBe("-> ep:users-api:.:GET /api/users/:id (high)");
    expect(at("createInvoice")).toBe("-> ep:billing:.:POST /invoices (high)");
    // The same method and path in two other repos: both are candidates, no edge.
    expect(at("health")).toBe(
      "ambiguous: GET /health [ep:billing:.:GET /health, ep:users-api:.:GET /health]",
    );
    expect(at("typed")).toBe("-> ep:users-api:.:GET /api/users (high)");
    expect(at("nothing")).toBe("no_endpoint: GET /api/nothing");
    expect(at("fromEnv")).toBe("dynamic_url: GET <dynamic>");
    expect(at("outside")).toBe("external_url: GET https://example.com/api/users");
  });

  it("gives the same graph whichever repo is indexed first, and from whichever repo the run starts", async () => {
    const first = workspaceOf("linking-repos", {
      web: "aaa-web",
      "users-api": "users-api",
      billing: "billing",
    });
    await indexRepo(first.paths("web"), { layer: "main" });
    const a = dump(first.paths("web"));
    expect(outcomes(a, "aaa-web").get("sym:aaa-web:src/calls.ts#listUsers")).toBe(
      "-> ep:users-api:.:GET /api/users (high)",
    );
    const last = workspaceOf("linking-repos", {
      web: "zzz-web",
      "users-api": "users-api",
      billing: "billing",
    });
    await indexRepo(last.paths("billing"), { layer: "main" });
    const b = dump(last.paths("billing"));
    expect([...outcomes(b, "zzz-web").values()]).toEqual([...outcomes(a, "aaa-web").values()]);
    // A second run changes nothing.
    await indexRepo(last.paths("web"), { layer: "main" });
    expect(JSON.stringify(dump(last.paths("web")))).toBe(JSON.stringify(b));
  });

  it("drops the edge when a targeted run in the other repo removes the handler, and brings it back", async () => {
    const { root, paths } = workspaceOf("linking-repos", NAMES);
    await indexRepo(paths("web"), { layer: "main" });
    const target = "ep:users-api:.:GET /api/users";
    expect(requests(dump(paths("web"))).some((e) => e.dst === target)).toBe(true);
    const app = join(root, "users-api/src/app.ts");
    const original = readFileSync(app, "utf8");
    writeFileSync(app, original.replace('users.get("/users", (c) => c.json([]));\n', ""));
    await indexRepo(paths("users-api"), { layer: "main", files: ["src/app.ts"] });
    const gone = dump(paths("web"));
    expect(requests(gone).some((e) => e.dst === target)).toBe(false);
    expect(outcomes(gone, "web").get("sym:web:src/calls.ts#listUsers")).toBe("no_endpoint: GET /api/users");
    writeFileSync(app, original);
    await indexRepo(paths("users-api"), { layer: "main", files: ["src/app.ts"] });
    expect(outcomes(dump(paths("web")), "web").get("sym:web:src/calls.ts#listUsers")).toBe(
      `-> ${target} (high)`,
    );
  });

  it("prefers the caller's own repo when it serves the same method and path", async () => {
    const { root, paths } = workspaceOf("linking-repos", NAMES);
    mkdirSync(join(root, "web/src"), { recursive: true });
    writeFileSync(
      join(root, "web/src/server.ts"),
      'import { Hono } from "hono";\nexport const local = new Hono();\nlocal.get("/health", (c) => c.text("ok"));\n',
    );
    await indexRepo(paths("web"), { layer: "main" });
    expect(outcomes(dump(paths("web")), "web").get("sym:web:src/calls.ts#health")).toBe(
      "-> ep:web:.:GET /health (high)",
    );
  });
});

describe("cross-repo calls on fixtures/multirepo", () => {
  it("links the page's fetch of /api/posts to the endpoint of the api repo", async () => {
    // The fixture's web package is of no known kind, so no client rule reads it: a client dependency makes it one.
    const { paths } = workspaceOf("multirepo", { web: "web", api: "acme/api" }, (root) => {
      const manifest = join(root, "web/package.json");
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { dependencies: Record<string, string> };
      pkg.dependencies.axios = "^1.7.0";
      writeFileSync(manifest, JSON.stringify(pkg));
    });
    await indexRepo(paths("web"), { layer: "main" });
    const edges = requests(dump(paths("web")));
    expect(edges.map((e) => [e.src, e.dst, e.confidence])).toEqual([
      ["sym:web:src/pages/posts.tsx#PostsPage", "ep:acme/api:mr-server:GET /api/posts", "high"],
    ]);
  });
});

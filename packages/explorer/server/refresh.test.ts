import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type GantryPaths, heal, resolvePaths } from "@gantry/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ExplorerServer, startExplorerServer } from "./index.js";
import { singleFlight } from "./refresh.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const rel = "packages/utils/src/slug.ts";

function call(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
  // biome-ignore lint/suspicious/noExplicitAny: test helper over arbitrary JSON bodies
): Promise<{ status: number; json: () => any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("explorer refresh (spec section 11 (c))", () => {
  let tmp = "";
  let repo = "";
  let paths: GantryPaths;
  let srv: ExplorerServer;
  let auth: Record<string, string>;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  const post = (headers: Record<string, string> = {}) =>
    call(srv.port, "POST", "/api/refresh", { ...auth, "content-type": "application/json", ...headers }, "{}");

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "gantry-refresh-"));
    repo = join(tmp, "repo");
    cpSync(join(fixtures, "pnpm-turbo"), repo, { recursive: true });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Gantry Test");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");
    paths = resolvePaths(repo, { HOME: join(tmp, "home"), CLAUDE_PLUGIN_DATA: join(tmp, "data") });
    await heal(paths); // no head_sha yet: a full index
    srv = await startExplorerServer({ paths, writeStateFile: false, getEmbedder: async () => undefined });
    auth = { "x-gantry-token": srv.token };
  }, 60_000);
  afterAll(async () => {
    await srv?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("marks views stale on the first request after a save, and refresh re-indexes the change", async () => {
    const view = () => call(srv.port, "GET", "/api/view/project-map?level=symbols", auth);
    expect((await view()).json().stale).toEqual({ files: 0 });
    expect((await call(srv.port, "GET", "/api/meta", auth)).json().stale).toEqual({ files: 0 });

    const original = readFileSync(join(repo, rel), "utf8");
    writeFileSync(
      join(repo, rel),
      `${original}\nexport function refreshedSlug(s: string): string {\n  return s;\n}\n`,
    );
    writeFileSync(
      join(repo, "packages/utils/src/added.ts"),
      "export const addedThing = (n: number) => n + 1;\n",
    );
    const stale = await view();
    expect(stale.json().stale).toEqual({ files: 2 });
    expect(stale.json().nodes.some((n: { label: string }) => n.label === "refreshedSlug")).toBe(false);

    const r = await post();
    expect(r.status).toBe(200);
    const body = r.json();
    expect(body.changed).toEqual({ files: 2, functions: 2 });
    expect(body.files).toEqual(["file:packages/utils/src/added.ts", `file:${rel}`]);
    expect(body.functions.added).toHaveLength(2);
    expect(body.functions.added.some((id: string) => id.includes("refreshedSlug"))).toBe(true);
    expect(body.functions.removed).toEqual([]);
    expect(body.healed).toBe(false);
    expect(typeof body.ms).toBe("number");

    const after = (await view()).json();
    expect(after.stale).toEqual({ files: 0 });
    expect(after.nodes.some((n: { label: string }) => n.label === "refreshedSlug")).toBe(true);

    // Nothing was written into the repository: git sees only the two edits.
    const status = execFileSync("git", ["status", "--porcelain=v1"], { cwd: repo, encoding: "utf8" });
    expect(status.split("\n").filter(Boolean).sort()).toEqual([
      ` M ${rel}`,
      "?? packages/utils/src/added.ts",
    ]);

    // A second refresh with nothing changed is a no-op.
    expect((await post()).json().changed).toEqual({ files: 0, functions: 0 });
  }, 60_000);

  it("heals first when HEAD moved", async () => {
    git("add", "-A");
    git("commit", "-q", "-m", "edits");
    expect((await call(srv.port, "GET", "/api/meta", auth)).json().stale.files).toBeGreaterThan(0);
    const body = (await post()).json();
    expect(body.healed).toBe(true);
    expect((await call(srv.port, "GET", "/api/meta", auth)).json().stale).toEqual({ files: 0 });
  }, 60_000);

  it("is protected like the rest of the API", async () => {
    expect((await post({ origin: "http://evil.example" })).status).toBe(403);
    expect((await post({ origin: `http://localhost:${srv.port}` })).status).toBe(403);
    expect((await post({ "x-gantry-token": "nope" })).status).toBe(403);
    expect(
      (await call(srv.port, "POST", "/api/refresh", { "content-type": "application/json" }, "{}")).status,
    ).toBe(403);
    expect(
      (
        await call(
          srv.port,
          "POST",
          "/api/refresh",
          { ...auth, "content-type": "application/json", host: "localhost" },
          "{}",
        )
      ).status,
    ).toBe(403);
    expect((await post({ "content-type": "text/plain" })).status).toBe(415);
    expect((await call(srv.port, "GET", "/api/refresh", auth)).status).toBe(404);
    expect((await post({ origin: `http://127.0.0.1:${srv.port}` })).status).toBe(200);
  }, 60_000);
});

describe("singleFlight", () => {
  it("runs one job at a time and hands concurrent callers the same result", async () => {
    let runs = 0;
    let release = () => {};
    const job = singleFlight(
      () =>
        new Promise<number>((ok) => {
          runs++;
          release = () => ok(runs);
        }),
    );
    const a = job();
    const b = job();
    release();
    expect(await a).toBe(1);
    expect(await b).toBe(1);
    const c = job();
    release();
    expect(await c).toBe(2);
  });
});

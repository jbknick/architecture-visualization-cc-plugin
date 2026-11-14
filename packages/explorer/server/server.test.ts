import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EdgeRecord,
  type FileRecord,
  type GantryPaths,
  loadConfig,
  openStore,
  resolvePaths,
  type Store,
  type SymbolRecord,
} from "@gantry/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildExplorerUrl,
  cookieName,
  type ExplorerServer,
  findRunningExplorer,
  HTML_CSP,
  startExplorerServer,
  startOrReuseExplorer,
  stateFilePath,
} from "./index.js";

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  // biome-ignore lint/suspicious/noExplicitAny: test helper over arbitrary JSON bodies
  json: () => any;
}

function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  hostOverride?: string,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { host: hostOverride ?? `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const fileRec = (path: string, ws: string | null = "ws:.", extra: Partial<FileRecord> = {}): FileRecord => ({
  id: `file:${path}`,
  path,
  workspaceId: ws,
  contentHash: `h-${path}`,
  mtimeMs: 1,
  deleted: false,
  ...extra,
});
const symRec = (path: string, name: string, extra: Partial<SymbolRecord> = {}): SymbolRecord => ({
  id: `sym:${path}#${name}`,
  fileId: `file:${path}`,
  name,
  kind: "function",
  exported: true,
  signature: `function ${name}(): void`,
  startLine: 1,
  endLine: 3,
  loc: 3,
  complexity: 1,
  stmtCount: 1,
  exactHash: `e-${name}`,
  shapeHash: `s-${name}`,
  minhash: new Uint32Array(64),
  ...extra,
});
const edgeRec = (path: string, src: string, dst: string, kind: EdgeRecord["kind"] = "calls"): EdgeRecord => ({
  src,
  dst,
  kind,
  confidence: "high",
  count: 2,
  evidence: [],
  fileId: `file:${path}`,
});

let tmp: string;
let repo: string;
let paths: GantryPaths;
let store: Store;
let srv: ExplorerServer;
let staticDir: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "gantry-explorer-"));
  repo = join(tmp, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const lines = Array.from({ length: 500 }, (_, i) => `// line ${i + 1}`).join("\n");
  writeFileSync(join(repo, "src", "big.ts"), lines);
  writeFileSync(
    join(repo, "src", "a.ts"),
    "export function alpha() {}\nexport function parseUserInput() {}\n",
  );
  writeFileSync(join(repo, "src", "b.ts"), "import { alpha } from './a';\nexport const b = alpha;\n");
  writeFileSync(join(repo, "src", "ignored.ts"), "export const ignored = 1;\n");
  writeFileSync(join(repo, ".gitignore"), "src/ignored.ts\n");
  mkdirSync(join(repo, "nested", "inner", "src"), { recursive: true });
  execFileSync("git", ["init", "-q", join(repo, "nested", "inner")]);
  writeFileSync(join(repo, "nested", "inner", "src", "n.ts"), "export const n = 1;\n");
  mkdirSync(join(tmp, "elsewhere"), { recursive: true });
  writeFileSync(join(tmp, "elsewhere", "e.ts"), "export const e = 1;\n");
  symlinkSync(join(tmp, "elsewhere"), join(repo, "linkdir"));
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  writeFileSync(join(repo, "src", "creds.ts"), "x");
  writeFileSync(join(tmp, "outside.ts"), "export const outside = 1;\n");
  symlinkSync(join(tmp, "outside.ts"), join(repo, "src", "link.ts"));
  symlinkSync(join(repo, ".env"), join(repo, "src", "envlink.ts"));

  paths = resolvePaths(repo, { HOME: join(tmp, "home"), CLAUDE_PLUGIN_DATA: join(tmp, "data") });
  store = openStore(paths.dbPath);
  store.upsertWorkspaces([
    { id: "ws:.", name: "root", dir: ".", kind: "app", frameworks: ["react"], deps: [], exportsMap: null },
    {
      id: "ws:lib",
      name: "lib",
      dir: "libs/lib",
      kind: "package",
      frameworks: [],
      deps: [],
      exportsMap: null,
    },
  ]);
  store.replaceFile(
    "main",
    fileRec("src/a.ts"),
    [symRec("src/a.ts", "alpha"), symRec("src/a.ts", "parseUserInput", { startLine: 2, endLine: 2 })],
    [
      edgeRec("src/a.ts", "ws:.", "ws:lib", "depends_on"),
      edgeRec("src/a.ts", "sym:src/a.ts#parseUserInput", "sym:src/a.ts#alpha"),
      edgeRec("src/a.ts", "file:src/a.ts", "sym:src/a.ts#alpha", "contains"),
    ],
  );
  store.replaceFile(
    "main",
    fileRec("src/b.ts"),
    [symRec("src/b.ts", "b", { kind: "const", exported: true })],
    [edgeRec("src/b.ts", "sym:src/b.ts#b", "sym:src/a.ts#alpha")],
  );
  store.fts.upsert("sym:src/a.ts#alpha", {
    nameTokens: "alpha",
    suggestedName: "",
    path: "src/a.ts",
    behavior: "",
    searchTerms: "",
  });
  store.fts.upsert("sym:src/a.ts#parseUserInput", {
    nameTokens: "parse user input",
    suggestedName: "",
    path: "src/a.ts",
    behavior: "",
    searchTerms: "",
  });
  store.setMeta("head_sha", "deadbeef");

  staticDir = join(tmp, "static");
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>ui</title>");
  writeFileSync(join(staticDir, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(tmp, "secret.txt"), "top secret");

  srv = await startExplorerServer({ paths, store, config: loadConfig(paths), staticDir });
});

afterAll(async () => {
  await srv.close();
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

const auth = () => ({ "x-gantry-token": srv.token });
const api = (path: string, headers: Record<string, string> = {}) =>
  get(srv.port, path, { ...auth(), ...headers });

describe("security", () => {
  it("binds 127.0.0.1 only, never 0.0.0.0", () => {
    const addr = srv.server.address();
    expect(addr).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
    expect(srv.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
  });

  it("rejects /api requests without a token (403)", async () => {
    expect((await get(srv.port, "/api/meta")).status).toBe(403);
    expect((await get(srv.port, "/api/meta", { "x-gantry-token": "nope" })).status).toBe(403);
    expect((await get(srv.port, "/api/meta", { cookie: `${cookieName(srv.port)}=wrong` })).status).toBe(403);
  });

  it("rejects a wrong Origin (403) and accepts the right one", async () => {
    expect((await api("/api/meta", { origin: "http://evil.example" })).status).toBe(403);
    expect((await api("/api/meta", { origin: `http://localhost:${srv.port}` })).status).toBe(403);
    expect((await api("/api/meta", { origin: `http://127.0.0.1:${srv.port}` })).status).toBe(200);
  });

  it("rejects a wrong Host (403), including for static pages", async () => {
    expect((await get(srv.port, "/api/meta", auth(), "evil.example")).status).toBe(403);
    expect((await get(srv.port, "/api/meta", auth(), `localhost:${srv.port}`)).status).toBe(403);
    expect((await get(srv.port, "/", {}, "evil.example")).status).toBe(403);
  });

  it("accepts the token as header or cookie (200)", async () => {
    expect((await get(srv.port, "/api/meta", auth())).status).toBe(200);
    expect(
      (await get(srv.port, "/api/meta", { cookie: `${cookieName(srv.port)}=${srv.token}` })).status,
    ).toBe(200);
  });

  it("names the cookie per port, so two explorers in one browser profile keep working", async () => {
    const other = await startExplorerServer({ paths, store, writeStateFile: false });
    try {
      expect(other.port).not.toBe(srv.port);
      const set = async (s: ExplorerServer) => {
        const res = await get(s.port, `/?t=${s.token}`);
        return String(res.headers["set-cookie"]).split(";")[0] as string;
      };
      const a = await set(srv);
      const b = await set(other);
      expect(a.startsWith(`gantry_t_${srv.port}=`)).toBe(true);
      expect(b.startsWith(`gantry_t_${other.port}=`)).toBe(true);
      const jar = `${a}; ${b}`; // what one browser sends to both ports
      expect((await get(srv.port, "/api/meta", { cookie: jar })).status).toBe(200);
      expect((await get(other.port, "/api/meta", { cookie: jar })).status).toBe(200);
      // A cookie for the other port (or the old shared name) never authenticates.
      expect((await get(srv.port, "/api/meta", { cookie: b })).status).toBe(403);
      expect((await get(other.port, "/api/meta", { cookie: a })).status).toBe(403);
      expect((await get(srv.port, "/api/meta", { cookie: `gantry_t=${srv.token}` })).status).toBe(403);
    } finally {
      await other.close();
    }
  });

  it("keeps the ?t= redirect on-origin whatever the path looks like", async () => {
    const evil = [
      "/.//evil.example/",
      "//evil.example/",
      "/\\evil.example/",
      "/./\\/evil.example/",
      "///evil.example",
    ];
    for (const p of evil) {
      const res = await get(srv.port, `${p}?t=${srv.token}&x=1`);
      expect(res.status, p).toBe(302);
      const loc = String(res.headers.location);
      expect(loc.startsWith("/") && !loc.startsWith("//"), `${p} -> ${loc}`).toBe(true);
      expect(new URL(loc, `http://127.0.0.1:${srv.port}`).origin).toBe(`http://127.0.0.1:${srv.port}`);
      expect(loc.endsWith("?x=1")).toBe(true);
    }
    expect((await get(srv.port, `/.//evil.example/?t=${srv.token}`)).headers.location).toBe("/evil.example/");
    expect((await get(srv.port, `/a/b/?t=${srv.token}`)).headers.location).toBe("/a/b/");
  });

  it("sends Referrer-Policy and a restrictive CSP on HTML responses", async () => {
    for (const p of ["/", "/some/route", "/index.html"]) {
      const res = await get(srv.port, p);
      expect(res.status, p).toBe(200);
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["content-security-policy"]).toBe(HTML_CSP);
    }
    expect(HTML_CSP).toContain("default-src 'none'");
    expect(HTML_CSP).toContain("connect-src 'self'");
    expect(HTML_CSP).not.toMatch(/script-src[^;]*unsafe/);
    // The placeholder page (no static dir) is HTML too.
    const bare = await startExplorerServer({ paths, store, writeStateFile: false });
    try {
      const res = await get(bare.port, "/");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["content-security-policy"]).toBe(HTML_CSP);
    } finally {
      await bare.close();
    }
    // Non-HTML responses carry the Referrer-Policy but no CSP.
    const js = await get(srv.port, "/assets/app.js");
    expect(js.headers["referrer-policy"]).toBe("no-referrer");
    expect(js.headers["content-security-policy"]).toBeUndefined();
    expect((await api("/api/meta")).headers["referrer-policy"]).toBe("no-referrer");
  });

  it("answers HEAD without a body and refuses other methods on every route", async () => {
    const m = (method: string, path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const r = request({ host: "127.0.0.1", port: srv.port, path, method, headers: auth() }, (res) => {
          let body = "";
          res.on("data", (c: Buffer) => {
            body += c.toString();
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        r.on("error", reject);
        r.end();
      });
    expect(await m("HEAD", "/api/source?path=src/ignored.ts")).toEqual({ status: 404, body: "" });
    expect((await m("HEAD", "/api/source?path=src/a.ts")).body).toBe("");
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      expect((await m(method, "/api/source?path=src/a.ts")).status, method).toBe(405);
      expect((await m(method, "/")).status, method).toBe(405);
    }
  });

  it("sets the cookie on ?t= and redirects to strip it", async () => {
    const res = await get(srv.port, `/?t=${srv.token}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/");
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toContain(`${cookieName(srv.port)}=${srv.token}`);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    expect((await get(srv.port, "/?t=wrong")).status).toBe(403);
  });

  it("rejects non-GET methods", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const r = request(
        { host: "127.0.0.1", port: srv.port, path: "/api/meta", method: "POST", headers: auth() },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      r.on("error", reject);
      r.end();
    });
    expect(status).toBe(405);
  });
});

function send(
  port: number,
  method: string,
  path: string,
  body: string | undefined,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", (err) => {
      // The server may cut the socket after an oversized body; surface that as a 413-like result.
      if (
        (err as NodeJS.ErrnoException).code === "ECONNRESET" ||
        (err as NodeJS.ErrnoException).code === "EPIPE"
      )
        resolve({ status: 413, body: "" });
      else reject(err);
    });
    req.end(body);
  });
}

describe("/api/layout/:view", () => {
  const json = (): Record<string, string> => ({ ...auth(), "content-type": "application/json" });
  const put = (view: string, body: unknown, headers = json()) =>
    send(
      srv.port,
      "PUT",
      `/api/layout/${view}`,
      typeof body === "string" ? body : JSON.stringify(body),
      headers,
    );

  it("returns no positions before anything is saved", async () => {
    expect((await api("/api/layout/debug")).json()).toEqual({ positions: {} });
  });

  it("saves and returns positions, replacing the earlier set", async () => {
    const res = await put("debug", { positions: { "ws:.": [1.5, -2], "ws:lib": [30, 40] } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ saved: 2 });
    expect((await api("/api/layout/debug")).json().positions).toEqual({
      "ws:.": [1.5, -2],
      "ws:lib": [30, 40],
    });
    await put("debug", { positions: { "ws:.": [9, 9] } });
    expect((await api("/api/layout/debug")).json().positions).toEqual({ "ws:.": [9, 9] });
  });

  it("404s unknown views and requires the token for PUT", async () => {
    expect((await put("nope", { positions: {} })).status).toBe(404);
    expect((await api("/api/layout/nope")).status).toBe(404);
    const noToken = await put("debug", { positions: {} }, { "content-type": "application/json" });
    expect(noToken.status).toBe(403);
    const badOrigin = await put("debug", { positions: {} }, { ...json(), origin: "http://evil.example" });
    expect(badOrigin.status).toBe(403);
  });

  it("validates the body shape and size", async () => {
    expect((await put("debug", "not json")).status).toBe(400);
    expect((await put("debug", [1, 2])).status).toBe(400);
    expect((await put("debug", { positions: [] })).status).toBe(400);
    expect((await put("debug", { positions: { a: [1] } })).status).toBe(400);
    expect((await put("debug", { positions: { a: [1, "2"] } })).status).toBe(400);
    expect((await put("debug", { positions: { a: [1, 1e30] } })).status).toBe(400);
    expect((await put("debug", { positions: { a: [1, 2] } }, auth())).status).toBe(415);
    const huge = JSON.stringify({ positions: { a: [1, 2] }, pad: "x".repeat(9 * 1024 * 1024) });
    expect((await put("debug", huge)).status).toBe(413);
  });

  it("accepts PUT on this route only", async () => {
    expect((await send(srv.port, "PUT", "/api/meta", "{}", json())).status).toBe(405);
    expect((await send(srv.port, "PUT", "/api/layout/debug/extra", "{}", json())).status).toBe(405);
    expect((await send(srv.port, "POST", "/api/layout/debug", "{}", json())).status).toBe(405);
    expect((await send(srv.port, "DELETE", "/api/layout/debug", undefined, json())).status).toBe(405);
  });
});

describe("static", () => {
  it("serves the build, falls back to index.html, 404s missing assets, blocks traversal", async () => {
    expect((await get(srv.port, "/")).body).toContain("<title>ui</title>");
    const js = await get(srv.port, "/assets/app.js");
    expect(js.status).toBe(200);
    expect(String(js.headers["content-type"])).toContain("javascript");
    expect((await get(srv.port, "/some/route")).body).toContain("<title>ui</title>");
    expect((await get(srv.port, "/assets/missing.js")).status).toBe(404);
    const trav = await get(srv.port, "/..%2fsecret.txt");
    expect(trav.body).not.toContain("top secret");
    expect((await get(srv.port, "/%2e%2e/secret.txt")).body).not.toContain("top secret");
  });

  it("serves a placeholder when no build exists", async () => {
    const s = await startExplorerServer({
      paths,
      store,
      staticDir: join(tmp, "nope"),
      writeStateFile: false,
    });
    try {
      const res = await get(s.port, "/");
      expect(res.status).toBe(200);
      expect(res.body).toContain("not built");
      expect(res.body).toContain("<title>Claude Code Architecture Visualisation Plugin</title>");
    } finally {
      await s.close();
    }
  });
});

describe("/api/meta", () => {
  it("returns repo, headSha, counts and views", async () => {
    const res = await api("/api/meta");
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({
      repo: "repo",
      headSha: "deadbeef",
      counts: { workspaces: 2, files: 2, symbols: 3, edges: 4 },
      views: expect.arrayContaining([
        { id: "debug", title: "Debug: workspaces", enabled: true },
        { id: "project-map", title: "Project map", enabled: true },
        { id: "ego", title: "Function ego graph", enabled: true },
        { id: "map-3d", title: "3D map", enabled: true },
      ]),
    });
  });
});

describe("/api/view/:id", () => {
  it("debug view returns workspaces and depends_on edges", async () => {
    const res = await api("/api/view/debug");
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({
      nodes: [
        { id: "ws:.", kind: "workspace", label: "root", size: 2, badges: ["app", "react"] },
        { id: "ws:lib", kind: "workspace", label: "lib", size: 0, badges: ["package"] },
      ],
      edges: [
        {
          id: "ws:.|depends_on|ws:lib",
          src: "ws:.",
          dst: "ws:lib",
          kind: "depends_on",
          weight: 2,
          confidence: "high",
        },
      ],
      layoutHint: "force",
    });
  });

  it("404s unknown views and 400s bad depth", async () => {
    expect((await api("/api/view/nope")).status).toBe(404);
    expect((await api("/api/view/debug?depth=abc")).status).toBe(400);
    expect((await api("/api/view/debug?focus=ws:.&depth=2&filters=a,b")).status).toBe(200);
  });
});

describe("/api/node/:id", () => {
  it("returns a symbol with signature, fan counts and grouped neighbors", async () => {
    const res = await api(`/api/node/${encodeURIComponent("sym:src/a.ts#alpha")}`);
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({
      node: {
        id: "sym:src/a.ts#alpha",
        kind: "function",
        name: "alpha",
        path: "src/a.ts",
        workspaceId: "ws:.",
        line: 1,
        endLine: 3,
        exported: true,
        loc: 3,
        complexity: 1,
      },
      signature: "function alpha(): void",
      fan_in: 2,
      fan_out: 0,
      neighbors: {
        calls: [
          {
            id: "sym:src/a.ts#parseUserInput",
            direction: "in",
            kind: "calls",
            label: "parseUserInput",
            confidence: "high",
            count: 2,
          },
          { id: "sym:src/b.ts#b", direction: "in", kind: "calls", label: "b", confidence: "high", count: 2 },
        ],
        contains: [
          {
            id: "file:src/a.ts",
            direction: "in",
            kind: "contains",
            label: "src/a.ts",
            confidence: "high",
            count: 2,
          },
        ],
      },
      untrusted_description: null,
    });
  });

  it("handles file and workspace nodes and 404s unknown ids", async () => {
    const f = (await api(`/api/node/${encodeURIComponent("file:src/a.ts")}`)).json();
    expect(f.node).toMatchObject({ kind: "file", path: "src/a.ts" });
    expect(f.signature).toBeNull();
    const w = (await api(`/api/node/${encodeURIComponent("ws:.")}`)).json();
    expect(w.node).toMatchObject({ kind: "workspace", name: "root" });
    expect(w.fan_out).toBe(1);
    expect(w.neighbors.depends_on[0]).toMatchObject({ id: "ws:lib", label: "lib", direction: "out" });
    expect((await api(`/api/node/${encodeURIComponent("sym:nope#x")}`)).status).toBe(404);
    expect((await api("/api/node/%E0%A4%A")).status).toBe(400);
  });
});

describe("/api/search", () => {
  it("matches by prefix over name tokens and path via FTS", async () => {
    const byToken = (await api("/api/search?q=pars")).json();
    expect(byToken.hits[0]).toEqual({
      id: "sym:src/a.ts#parseUserInput",
      name: "parseUserInput",
      kind: "function",
      path: "src/a.ts",
      line: 2,
      exported: true,
    });
    const byPath = (await api("/api/search?q=src/a")).json();
    expect(byPath.hits.map((h: { name: string }) => h.name).sort()).toEqual(["alpha", "parseUserInput"]);
  });

  it("falls back to case-insensitive substring on the symbol name", async () => {
    const res = (await api("/api/search?q=SERINP")).json();
    expect(res.hits.map((h: { name: string }) => h.name)).toEqual(["parseUserInput"]);
  });

  it("ranks exact name matches first, ignores empty and hostile queries, and limits to 20", async () => {
    expect((await api("/api/search?q=")).json()).toEqual({ hits: [] });
    expect((await api(`/api/search?q=${encodeURIComponent('"* OR NEAR(')}`)).status).toBe(200);
    expect((await api("/api/search?q=alpha")).json().hits[0].name).toBe("alpha");

    const many = openStore(":memory:");
    for (let i = 0; i < 30; i++) {
      const p = `src/m${i}.ts`;
      many.replaceFile("main", fileRec(p), [symRec(p, `widget${i}`)], []);
    }
    const s = await startExplorerServer({ paths, store: many, writeStateFile: false });
    try {
      const res = await get(s.port, "/api/search?q=widget", { "x-gantry-token": s.token });
      expect(res.json().hits).toHaveLength(20);
    } finally {
      await s.close();
      many.close();
    }
  });
});

describe("/api/source", () => {
  const src = (q: string) => api(`/api/source?${q}`);
  // Indexed only for these tests, so the counts asserted by the other describes stay put. The symlinks
  // are indexed on purpose: they must still be refused by the realpath checks, not just by the lookup.
  const extras = ["src/big.ts", "src/envlink.ts", "src/link.ts", "src/creds.ts"];
  beforeAll(() => {
    for (const p of extras) store.replaceFile("main", fileRec(p), [], []);
  });
  afterAll(() => {
    for (const p of extras) store.replaceFile("main", fileRec(p, "ws:.", { deleted: true }), [], []);
  });

  it("returns the requested lines", async () => {
    const res = await src("path=src/a.ts&start=2&end=2");
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({
      path: "src/a.ts",
      start: 2,
      end: 2,
      total: 2,
      lines: ["export function parseUserInput() {}"],
    });
  });

  it("caps at 400 lines", async () => {
    const res = (await src("path=src/big.ts&start=1&end=500")).json();
    expect(res.lines).toHaveLength(400);
    expect(res.end).toBe(400);
    expect(res.total).toBe(500);
    expect((await src("path=src/big.ts")).json().lines).toHaveLength(400);
  });

  it("refuses .env and other sensitive or non-indexable paths", async () => {
    expect((await src("path=.env")).status).toBe(403);
    expect((await src("path=src/envlink.ts")).status).toBe(403); // symlink to .env
    expect((await src("path=package.json")).status).toBe(403);
  });

  it("refuses paths outside the repo", async () => {
    expect((await src("path=../outside.ts")).status).toBe(403);
    expect((await src(`path=${encodeURIComponent("src/../../outside.ts")}`)).status).toBe(403);
    expect((await src(`path=${encodeURIComponent(join(tmp, "outside.ts"))}`)).status).toBe(403);
    expect((await src("path=src/link.ts")).status).toBe(403); // symlink escaping the repo
  });

  it("only serves files present in the index (effectiveFiles)", async () => {
    // Present on disk and indexable by pattern, but git-ignored / in a nested repo / under a symlinked dir.
    expect((await src("path=src/a.ts")).status).toBe(200);
    for (const p of ["src/ignored.ts", "nested/inner/src/n.ts", "linkdir/e.ts"]) {
      const res = await src(`path=${encodeURIComponent(p)}`);
      expect([403, 404], p).toContain(res.status);
      expect(res.body).not.toContain("export const");
    }
  });

  it("is not fooled by encodings, slashes, case or normalisation", async () => {
    const variants = [
      "src/ignored.ts",
      "./src/ignored.ts",
      "src//ignored.ts",
      "src/./ignored.ts",
      "src/ignored.ts/",
      "SRC/IGNORED.TS",
      "src\\ignored.ts",
      "src/ignored.ts\0",
      " src/ignored.ts",
      "src/ignored.ts ",
    ];
    for (const v of variants) {
      const res = await src(`path=${encodeURIComponent(v)}`);
      expect([403, 404], v).toContain(res.status);
    }
    expect([403, 404]).toContain((await src("path=src%252Fignored.ts")).status); // double-encoded
    expect([403, 404]).toContain((await api("/api/source/?path=src/ignored.ts")).status);
    expect((await api("/api/%73ource?path=src/a.ts")).status).toBe(404);
    // Normalised aliases of an indexed file stay readable (the lookup uses the normalised path).
    expect((await src("path=./src/a.ts")).status).toBe(200);
    // Repeated parameters: the first one is what counts for both the check and the read.
    expect([403, 404]).toContain((await src("path=src/ignored.ts&path=src/a.ts")).status);
    expect((await src("path=src/a.ts&path=src/ignored.ts")).json().path).toBe("src/a.ts");
  });

  it("refuses an indexed symlink that points at a file the index does not know", async () => {
    const alias = join(repo, "src", "alias.ts");
    symlinkSync(join(repo, "src", "ignored.ts"), alias);
    store.replaceFile("main", fileRec("src/alias.ts"), [], []);
    try {
      expect([403, 404]).toContain((await src("path=src/alias.ts")).status);
    } finally {
      store.replaceFile("main", fileRec("src/alias.ts", "ws:.", { deleted: true }), [], []);
      rmSync(alias);
    }
  });

  it("validates parameters and missing files", async () => {
    expect((await src("")).status).toBe(400);
    expect((await src("path=src/a.ts&start=0")).status).toBe(400);
    expect((await src("path=src/a.ts&start=5&end=2")).status).toBe(400);
    expect((await src("path=src/missing.ts")).status).toBe(404);
  });
});

describe("explorer.json and reuse", () => {
  it("writes explorer.json with port and token, removed on close", async () => {
    const file = stateFilePath(paths);
    const state = JSON.parse(readFileSync(file, "utf8"));
    expect(state).toMatchObject({ port: srv.port, token: srv.token, pid: process.pid });

    const other = { ...paths, dataDir: join(tmp, "other-data") };
    const s = await startExplorerServer({ paths: other, store, config: loadConfig(paths) });
    expect(existsSync(stateFilePath(other))).toBe(true);
    await s.close();
    expect(existsSync(stateFilePath(other))).toBe(false);
  });

  it("a second start reuses the first server", async () => {
    const again = await startOrReuseExplorer({ paths, store, staticDir });
    expect(again.reused).toBe(true);
    expect(again.port).toBe(srv.port);
    expect(again.token).toBe(srv.token);
    expect(again.url).toBe(srv.url);
    expect(again.server).toBeUndefined();
  });

  it("ignores and removes a stale explorer.json, then starts fresh", async () => {
    const dataDir = join(tmp, "stale-data");
    mkdirSync(dataDir, { recursive: true });
    const p = { ...paths, dataDir };
    writeFileSync(stateFilePath(p), JSON.stringify({ port: 1, token: "x", pid: 999999999, startedAt: "" }));
    expect(await findRunningExplorer(p)).toBeUndefined();
    expect(existsSync(stateFilePath(p))).toBe(false);

    writeFileSync(stateFilePath(p), JSON.stringify({ port: 1, token: "x", pid: process.pid, startedAt: "" }));
    const run = await startOrReuseExplorer({ paths: p, store });
    try {
      expect(run.reused).toBe(false);
      expect(run.port).not.toBe(1);
    } finally {
      await run.server?.close();
    }
  });
});

describe("buildExplorerUrl", () => {
  it("builds the documented URL shape", () => {
    expect(buildExplorerUrl({ port: 1234, token: "tok" })).toBe("http://127.0.0.1:1234/?t=tok");
    expect(
      buildExplorerUrl({
        port: 1234,
        token: "tok",
        view: "debug",
        focus: "sym:a#b",
        filters: { kind: "hook" },
      }),
    ).toBe("http://127.0.0.1:1234/?t=tok#/debug?focus=sym%3Aa%23b&kind=hook");
  });
});

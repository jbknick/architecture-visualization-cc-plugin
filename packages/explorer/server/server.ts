import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { type GantryConfig, type GantryPaths, loadConfig, openStore, type Store } from "@gantry/core";
import { HttpError, handleApi } from "./api.js";
import { buildExplorerUrl } from "./url.js";

export interface ExplorerServerOptions {
  paths: GantryPaths;
  /** Port to bind on 127.0.0.1; 0 (default) lets the OS pick. */
  port?: number;
  /** Directory holding the Vite build. Default: none (a placeholder page is served). */
  staticDir?: string;
  /** Inject a store (tests); otherwise `paths.dbPath` is opened and closed with the server. */
  store?: Store;
  config?: GantryConfig;
  /** Write `<dataDir>/explorer.json` (default true). */
  writeStateFile?: boolean;
}

export interface ExplorerServer {
  port: number;
  token: string;
  url: string;
  server: Server;
  close(): Promise<void>;
}

export interface ExplorerState {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

export const stateFilePath = (p: GantryPaths): string => path.join(p.dataDir, "explorer.json");

const COOKIE = "gantry_t";
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(data);
}

const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>Gantry</title><body style="font-family:system-ui;padding:2rem"><h1>Gantry explorer</h1><p>The explorer UI is not built yet. The JSON API is available under <code>/api/</code>.</p>`;

function serveStatic(res: ServerResponse, staticDir: string | undefined, pathname: string): void {
  const respondPlaceholder = () => {
    res.writeHead(200, { "content-type": MIME[".html"] as string, "cache-control": "no-store" });
    res.end(PLACEHOLDER);
  };
  if (!staticDir || !existsSync(staticDir)) return void respondPlaceholder();
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return void sendJson(res, 400, { error: "Bad path" });
  }
  if (rel.includes("\0")) return void sendJson(res, 400, { error: "Bad path" });
  const root = realpathSync(staticDir);
  let file = path.join(root, path.normalize(`/${rel}`));
  let real: string | undefined;
  try {
    real = realpathSync(file);
  } catch {
    real = undefined;
  }
  if (real && (real === root || !real.startsWith(root + path.sep))) real = undefined; // outside or directory root
  if (real && !statSync(real).isFile()) real = undefined;
  if (!real) {
    // SPA fallback for extension-less routes; missing assets are 404.
    if (path.extname(rel)) return void sendJson(res, 404, { error: "Not found" });
    file = path.join(root, "index.html");
    if (!existsSync(file)) return void respondPlaceholder();
    real = realpathSync(file);
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(real).toLowerCase()] ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
    "cache-control": "no-cache",
  });
  createReadStream(real).pipe(res);
}

export async function startExplorerServer(opts: ExplorerServerOptions): Promise<ExplorerServer> {
  const { paths } = opts;
  const ownsStore = !opts.store;
  const store = opts.store ?? openStore(paths.dbPath);
  const config = opts.config ?? loadConfig(paths);
  const token = randomBytes(32).toString("base64url");
  const ctx = { store, paths, config };
  let port = 0;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    try {
      const host = `127.0.0.1:${port}`;
      // DNS-rebinding guard: applies to every request.
      if (req.headers.host !== host) return void sendJson(res, 403, { error: "Bad Host" });
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("allow", "GET, HEAD");
        return void sendJson(res, 405, { error: "Method not allowed" });
      }
      const url = new URL(req.url ?? "/", `http://${host}`);

      if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== `http://${host}`) {
          return void sendJson(res, 403, { error: "Bad Origin" });
        }
        const header = req.headers["x-gantry-token"];
        const supplied =
          (Array.isArray(header) ? header[0] : header) ?? parseCookies(req.headers.cookie)[COOKIE];
        if (!supplied || !safeEqual(supplied, token))
          return void sendJson(res, 403, { error: "Missing or bad token" });
        return void sendJson(res, 200, handleApi(ctx, url.pathname, url.searchParams));
      }

      // First load: `?t=<token>` sets the cookie and redirects to strip it (the #fragment survives).
      const t = url.searchParams.get("t");
      if (t !== null) {
        if (!safeEqual(t, token)) return void sendJson(res, 403, { error: "Bad token" });
        url.searchParams.delete("t");
        res.writeHead(302, {
          "set-cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
          location: `${url.pathname}${url.search}`,
          "cache-control": "no-store",
        });
        return void res.end();
      }
      serveStatic(res, opts.staticDir, url.pathname);
    } catch (err) {
      if (err instanceof HttpError) return void sendJson(res, err.status, { error: err.message });
      sendJson(res, 500, { error: "Internal error" });
    }
  };

  const server = createServer(handler);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? 0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (err) {
    if (ownsStore) store.close();
    throw err;
  }
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Unexpected server address");
  port = addr.port;

  const writeState = opts.writeStateFile !== false;
  const file = stateFilePath(paths);
  if (writeState) {
    mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
    const state: ExplorerState = { port, token, pid: process.pid, startedAt: new Date().toISOString() };
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  }
  const removeState = () => {
    try {
      const cur = JSON.parse(readFileSync(file, "utf8")) as ExplorerState;
      if (cur.token === token) rmSync(file, { force: true });
    } catch {
      // already gone
    }
  };

  let closed: Promise<void> | undefined;
  return {
    port,
    token,
    url: buildExplorerUrl({ port, token }),
    server,
    close() {
      closed ??= (async () => {
        if (writeState) removeState();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        if (ownsStore) store.close();
      })();
      return closed;
    },
  };
}

export interface RunningExplorer {
  port: number;
  token: string;
  url: string;
  reused: boolean;
  /** Present only when this call started the server. */
  server?: ExplorerServer;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Reads `explorer.json` and verifies the server really answers with that token; removes stale files. */
export async function findRunningExplorer(paths: GantryPaths): Promise<ExplorerState | undefined> {
  const file = stateFilePath(paths);
  let state: ExplorerState;
  try {
    state = JSON.parse(readFileSync(file, "utf8")) as ExplorerState;
  } catch {
    return undefined;
  }
  const valid =
    Number.isInteger(state.port) && typeof state.token === "string" && Number.isInteger(state.pid);
  if (valid && processAlive(state.pid)) {
    try {
      const res = await fetch(`http://127.0.0.1:${state.port}/api/meta`, {
        headers: { "x-gantry-token": state.token },
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return state;
    } catch {
      // not answering
    }
  }
  rmSync(file, { force: true });
  return undefined;
}

/** One server per worktree: reuse the one in `explorer.json` if it answers, else start a new one. */
export async function startOrReuseExplorer(opts: ExplorerServerOptions): Promise<RunningExplorer> {
  const existing = await findRunningExplorer(opts.paths);
  if (existing) {
    return {
      port: existing.port,
      token: existing.token,
      url: buildExplorerUrl({ port: existing.port, token: existing.token }),
      reused: true,
    };
  }
  const server = await startExplorerServer(opts);
  return { port: server.port, token: server.token, url: server.url, reused: false, server };
}

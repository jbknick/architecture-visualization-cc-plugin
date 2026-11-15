import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import {
  cachedEmbedder,
  type Embedder,
  type GantryConfig,
  type GantryPaths,
  loadConfig,
  openStore,
  type Store,
} from "@gantry/core";
import { HttpError, handleApi } from "./api.js";
import { MAX_DISMISS_BODY_BYTES, putDismiss } from "./dismiss.js";
import { MAX_LAYOUT_BODY_BYTES, putLayout } from "./layout.js";
import { type RefreshResult, runRefresh, singleFlight, staleInfo } from "./refresh.js";
import {
  acquireLock,
  createStateFile,
  ExplorerAlreadyRunning,
  type ExplorerState,
  findRunningExplorer,
  inspectExplorer,
  removeStateFile,
  stateFilePath,
} from "./state.js";
import { buildExplorerUrl } from "./url.js";
import { clearReviewCache } from "./views/review.js";

export {
  ExplorerAlreadyRunning,
  type ExplorerState,
  ExplorerUnresponsive,
  findRunningExplorer,
  stateFilePath,
} from "./state.js";

export interface ExplorerServerOptions {
  paths: GantryPaths;
  /** Port to bind on 127.0.0.1; 0 (default) lets the OS pick. */
  port?: number;
  /** Directory holding the Vite build. Default: none (a placeholder page is served). */
  staticDir?: string;
  /** Inject a store (tests); otherwise `paths.dbPath` is opened and closed with the server. */
  store?: Store;
  config?: GantryConfig;
  /** Default: the embedding model if it is already cached. Tests pass a fake or `async () => undefined`. */
  getEmbedder?: () => Promise<Embedder | undefined>;
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

export const cookieName = (port: number): string => `gantry_t_${port}`;

/**
 * Sent with every HTML response. Same-origin scripts only (Vite emits module scripts and an ES worker as
 * same-origin files); inline styles are allowed because React sets `style` attributes; `blob:` covers the
 * layout Web Worker and WebGL texture uploads; everything else is closed.
 */
export const HTML_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");
const REFERRER_POLICY = "no-referrer";
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

const LAYOUT_ROUTE = /^\/api\/layout\/[^/]+$/;
const DISMISS_ROUTE = "/api/dismiss";
const REFRESH_ROUTE = "/api/refresh";
const MAX_REFRESH_BODY_BYTES = 1024;
/** Responses that carry `stale: { files }` (spec section 11 (c)). */
const STALE_ROUTE = /^\/api\/(meta|view\/[^/]+)$/;

/** Reads a request body up to `limit` bytes; rejects with a 413 HttpError beyond that. */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

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
    "referrer-policy": REFERRER_POLICY,
  });
  res.end(data);
}

const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>Claude Code Architecture Visualisation Plugin</title><body style="font-family:system-ui;padding:2rem"><h1>Claude Code Architecture Visualisation Plugin</h1><p>The explorer UI is not built yet. The JSON API is available under <code>/api/</code>.</p>`;

function serveStatic(res: ServerResponse, staticDir: string | undefined, pathname: string): void {
  const respondPlaceholder = () => {
    res.writeHead(200, {
      "content-type": MIME[".html"] as string,
      "cache-control": "no-store",
      "referrer-policy": REFERRER_POLICY,
      "content-security-policy": HTML_CSP,
      "x-content-type-options": "nosniff",
    });
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
  const type = MIME[path.extname(real).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "cache-control": "no-cache",
    "referrer-policy": REFERRER_POLICY,
    ...(type === MIME[".html"] ? { "content-security-policy": HTML_CSP } : {}),
  });
  createReadStream(real).pipe(res);
}

/**
 * Starts the server. With a state file (the default) the whole start runs under `explorer.lock`, so concurrent
 * starters take turns (this also keeps them from opening the database together) and a loser that finds a live
 * explorer answers before it opens anything.
 */
export async function startExplorerServer(opts: ExplorerServerOptions): Promise<ExplorerServer> {
  if (opts.writeStateFile === false) return startLocked(opts);
  mkdirSync(opts.paths.dataDir, { recursive: true, mode: 0o700 });
  const release = await acquireLock(opts.paths);
  try {
    const found = await inspectExplorer(opts.paths); // removes an unreadable file or one of a dead process
    if (found.kind === "state") throw new ExplorerAlreadyRunning(found.state.port, found.state.pid);
    return await startLocked(opts);
  } finally {
    release();
  }
}

async function startLocked(opts: ExplorerServerOptions): Promise<ExplorerServer> {
  const { paths } = opts;
  const ownsStore = !opts.store;
  const store = opts.store ?? openStore(paths.dbPath);
  const config = opts.config ?? loadConfig(paths);
  const token = randomBytes(32).toString("base64url");
  const ctx = { store, paths, config, getEmbedder: opts.getEmbedder ?? cachedEmbedder() };
  let port = 0;
  // A refresh changes the graph the review view walked, so its cached impacts are dropped too.
  const refresh = singleFlight<RefreshResult>(() =>
    runRefresh(paths, store).finally(() => clearReviewCache()),
  );
  const withStale = (pathname: string, body: unknown): unknown =>
    STALE_ROUTE.test(pathname) && typeof body === "object" && body !== null
      ? { ...body, stale: staleInfo(paths, store) }
      : body;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    try {
      const host = `127.0.0.1:${port}`;
      // DNS-rebinding guard: applies to every request.
      if (req.headers.host !== host) return void sendJson(res, 403, { error: "Bad Host" });
      const url = new URL(req.url ?? "/", `http://${host}`);
      const layoutPut = req.method === "PUT" && LAYOUT_ROUTE.test(url.pathname);
      const dismissPut = req.method === "PUT" && url.pathname === DISMISS_ROUTE;
      const refreshPost = req.method === "POST" && url.pathname === REFRESH_ROUTE;
      if (req.method !== "GET" && req.method !== "HEAD" && !layoutPut && !dismissPut && !refreshPost) {
        res.setHeader("allow", "GET, HEAD");
        return void sendJson(res, 405, { error: "Method not allowed" });
      }

      if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== `http://${host}`) {
          return void sendJson(res, 403, { error: "Bad Origin" });
        }
        const header = req.headers["x-gantry-token"];
        const supplied =
          (Array.isArray(header) ? header[0] : header) ?? parseCookies(req.headers.cookie)[cookieName(port)];
        if (!supplied || !safeEqual(supplied, token))
          return void sendJson(res, 403, { error: "Missing or bad token" });
        if (layoutPut || dismissPut || refreshPost) {
          let run: (body: unknown) => unknown;
          let limit: number;
          if (refreshPost) {
            limit = MAX_REFRESH_BODY_BYTES;
            run = () => refresh();
          } else if (dismissPut) {
            limit = MAX_DISMISS_BODY_BYTES;
            run = (body) => putDismiss(ctx, body);
          } else {
            let view: string;
            try {
              view = decodeURIComponent(url.pathname.slice("/api/layout/".length));
            } catch {
              return void sendJson(res, 400, { error: "Malformed id" });
            }
            limit = MAX_LAYOUT_BODY_BYTES;
            run = (body) => putLayout(store, view, body);
          }
          if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
            return void sendJson(res, 415, { error: "Content-Type must be application/json" });
          }
          readBody(req, limit).then(
            (text) => {
              const fail = (err: unknown) => {
                if (err instanceof HttpError) return void sendJson(res, err.status, { error: err.message });
                if (err instanceof SyntaxError) return void sendJson(res, 400, { error: "Invalid JSON" });
                sendJson(res, 500, { error: "Internal error" });
              };
              try {
                const out = run(JSON.parse(refreshPost && text === "" ? "{}" : text));
                if (out instanceof Promise) out.then((b) => sendJson(res, 200, b), fail);
                else sendJson(res, 200, out);
              } catch (err) {
                fail(err);
              }
            },
            (err: unknown) => {
              const tooLarge = err instanceof HttpError;
              sendJson(res, tooLarge ? err.status : 400, { error: tooLarge ? err.message : "Bad body" });
            },
          );
          return;
        }
        const body = handleApi(ctx, url.pathname, url.searchParams);
        if (body instanceof Promise) {
          body.then(
            (b) => sendJson(res, 200, withStale(url.pathname, b)),
            (err: unknown) => {
              if (err instanceof HttpError) return void sendJson(res, err.status, { error: err.message });
              sendJson(res, 500, { error: "Internal error" });
            },
          );
          return;
        }
        return void sendJson(res, 200, withStale(url.pathname, body));
      }

      // First load: `?t=<token>` sets the cookie and redirects to strip it (the #fragment survives).
      const t = url.searchParams.get("t");
      if (t !== null) {
        if (!safeEqual(t, token)) return void sendJson(res, 403, { error: "Bad token" });
        url.searchParams.delete("t");
        // Collapse leading slashes so `/.//evil.example/` (pathname `//evil.example/`) cannot become a
        // protocol-relative, off-site Location.
        const safePath = `/${url.pathname.replace(/^\/+/, "")}`;
        res.writeHead(302, {
          "set-cookie": `${cookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/`,
          location: `${safePath}${url.search}`,
          "referrer-policy": REFERRER_POLICY,
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
  if (writeState) {
    mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
    const state: ExplorerState = { port, token, pid: process.pid, startedAt: new Date().toISOString() };
    try {
      // The caller holds explorer.lock, so nobody else decides "no explorer runs" or writes explorer.json now.
      for (let attempt = 0; ; attempt++) {
        if (createStateFile(paths, state)) break;
        const found = await inspectExplorer(paths); // removes an unreadable file or one of a dead process
        if (found.kind === "state") throw new ExplorerAlreadyRunning(found.state.port, found.state.pid);
        if (attempt >= 20) throw new Error("explorer.json exists but cannot be read or replaced");
        if (found.kind === "young") await new Promise((r) => setTimeout(r, 100));
      }
    } catch (err) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      if (ownsStore) store.close();
      throw err;
    }
  }
  const removeState = () => removeStateFile(paths, token);

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
  let server: ExplorerServer;
  try {
    server = await startExplorerServer(opts);
  } catch (err) {
    // Lost the race for explorer.json: serve nothing, hand back the winner.
    if (err instanceof ExplorerAlreadyRunning) {
      const w = await findRunningExplorer(opts.paths);
      if (w) {
        return {
          port: w.port,
          token: w.token,
          url: buildExplorerUrl({ port: w.port, token: w.token }),
          reused: true,
        };
      }
    }
    throw err;
  }
  return { port: server.port, token: server.token, url: server.url, reused: false, server };
}

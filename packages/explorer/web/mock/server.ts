// Dev/test mock of the explorer server: serves the built UI from plugin/dist/explorer plus the fixture API.
// Run with `pnpm --filter @gantry/explorer mock` after `pnpm --filter @gantry/explorer build:web`.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleMockApi, handleMockWrite, mockLayouts } from "./fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../plugin/dist/explorer");
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "PUT" && url.pathname.startsWith("/api/layout/")) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        positions: Record<string, [number, number]>;
      };
      mockLayouts.set(decodeURIComponent(url.pathname.slice("/api/layout/".length)), body.positions);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ saved: Object.keys(body.positions).length }));
    } catch {
      res.writeHead(400).end();
    }
    return;
  }
  if (req.method === "PUT" && url.pathname === "/api/dismiss") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      // handled below as a bad body
    }
    const out = handleMockWrite(url, parsed) ?? { status: 404, body: { error: "Unknown route" } };
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
    return;
  }
  const api = handleMockApi(url);
  if (api) {
    res.writeHead(api.status, { "content-type": "application/json" });
    res.end(JSON.stringify(api.body));
    return;
  }
  const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
  try {
    const file = join(root, rel);
    if (!file.startsWith(root)) throw new Error("outside root");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const port = Number(process.env.MOCK_PORT ?? 4173);
server.listen(port, "127.0.0.1", () => console.log(`mock explorer on http://127.0.0.1:${port}`));

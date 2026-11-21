// A fake GitHub API on node:http for the Action's tests and for scripts/action-e2e.ts: just the pull request comment
// endpoints. Nothing here makes a real network call; it listens on 127.0.0.1 only.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeComment {
  id: number;
  body: string;
  user: { login: string };
  html_url: string;
}

export interface FakeCall {
  method: string;
  path: string;
  status: number;
}

export interface FakeGithubOptions {
  /** Comments already on the pull request, oldest first. */
  comments?: { body: string; login?: string }[];
  /** Comments per page of the list; a `Link: rel="next"` header points at the next page. Default 100. */
  pageSize?: number;
  /** Answer every create and update with this status (403 is what a fork's read-only token gets). */
  refuseWrites?: number;
  /** Answer the list with this status. */
  refuseReads?: number;
  /** Fail this many writes with 502 before one succeeds. */
  failWrites?: number;
  token?: string;
}

export interface FakeGithub {
  url: string;
  comments: FakeComment[];
  calls: FakeCall[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startFakeGithub(opts: FakeGithubOptions = {}): Promise<FakeGithub> {
  const token = opts.token ?? "test-token";
  const pageSize = opts.pageSize ?? 100;
  let nextId = 1000;
  let failWrites = opts.failWrites ?? 0;
  const comments: FakeComment[] = [];
  const calls: FakeCall[] = [];
  let origin = "";
  const add = (body: string, login = "github-actions[bot]"): FakeComment => {
    const id = nextId++;
    const c = { id, body, user: { login }, html_url: `${origin}/pull/1#issuecomment-${id}` };
    comments.push(c);
    return c;
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
      calls.push({ method: req.method ?? "", path: url.pathname, status });
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: "Bad credentials" });
    const list = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(url.pathname);
    const one = /^\/repos\/([^/]+)\/([^/]+)\/issues\/comments\/(\d+)$/.exec(url.pathname);
    const body = req.method === "GET" ? "" : await readBody(req);
    if (req.method !== "GET") {
      if (opts.refuseWrites) {
        return send(opts.refuseWrites, { message: "Resource not accessible by integration" });
      }
      if (failWrites > 0) {
        failWrites--;
        return send(502, { message: "Bad Gateway" });
      }
    }
    if (list && req.method === "GET") {
      if (opts.refuseReads)
        return send(opts.refuseReads, { message: "Resource not accessible by integration" });
      const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
      const slice = comments.slice((page - 1) * pageSize, page * pageSize);
      const headers: Record<string, string> = {};
      if (page * pageSize < comments.length) {
        headers.link = `<${origin}${url.pathname}?per_page=100&page=${page + 1}>; rel="next"`;
      }
      return send(200, slice, headers);
    }
    if (list && req.method === "POST") {
      const parsed = JSON.parse(body) as { body: string };
      return send(201, add(parsed.body, "github-actions[bot]"));
    }
    if (one && req.method === "PATCH") {
      const found = comments.find((c) => c.id === Number(one[3]));
      if (!found) return send(404, { message: "Not Found" });
      found.body = (JSON.parse(body) as { body: string }).body;
      return send(200, found);
    }
    return send(404, { message: "Not Found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const c of opts.comments ?? []) add(c.body, c.login);
  return {
    url: origin,
    comments,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

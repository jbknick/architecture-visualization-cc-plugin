import { formatDate, parseCursor } from "@mr/contracts";
import type { Context } from "hono";

const POSTS = [
  { id: "1", title: "First post", createdAt: "2026-01-02T03:04:05Z" },
  { id: "2", title: "Second post", createdAt: "2026-02-03T04:05:06Z" },
];

export function listPosts(c: Context) {
  const start = parseCursor(c.req.query("cursor"));
  const page = POSTS.slice(start).map((p) => ({ ...p, createdAt: formatDate(p.createdAt) }));
  return c.json(page);
}

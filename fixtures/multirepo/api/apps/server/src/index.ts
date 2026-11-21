import { Hono } from "hono";
import { listPosts } from "./posts.ts";

export const app = new Hono();

app.get("/api/posts", listPosts);

export default app;

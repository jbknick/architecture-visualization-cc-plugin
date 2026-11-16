import { Hono } from "hono";
import { showPost } from "./handlers";

export const posts = new Hono();

posts.get("/posts/:id", showPost);
posts.post("/posts", async (c) => c.json({ created: true }, 201));
posts.on(["PUT", "PATCH"], "/posts/:id", async (c) => c.json({ updated: true }));

import { Hono } from "hono";
import { getPost, createPost } from "@acme/db";

export const app = new Hono();

app.get("/posts/:id", async (c) => {
  const post = await getPost(c.req.param("id"));
  return c.json(post);
});

app.post("/posts", async (c) => {
  const body = await c.req.json();
  const created = await createPost(body);
  return c.json(created, 201);
});

import { Hono } from "hono";

const users = new Hono();
users.get("/users", (c) => c.json([]));
users.get("/users/:id", (c) => c.json({}));
users.post("/users", (c) => c.json({}));
users.put("/users/:id", (c) => c.json({}));
users.delete("/users/:id", (c) => c.json({}));
users.get("/users/me", (c) => c.json({}));
users.get("/orders/:id", (c) => c.json({}));
users.get("/posts/:postId/comments", (c) => c.json([]));

export const app = new Hono();
app.get("/health", (c) => c.text("ok"));
app.route("/api", users);

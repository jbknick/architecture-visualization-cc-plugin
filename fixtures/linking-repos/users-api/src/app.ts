import { Hono } from "hono";

const users = new Hono();
users.get("/users", (c) => c.json([]));
users.get("/users/:id", (c) => c.json({}));
users.post("/users", (c) => c.json({}));

export const app = new Hono();
app.get("/health", (c) => c.text("ok"));
app.route("/api", users);

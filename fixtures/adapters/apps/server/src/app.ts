import { posts } from "@demo/posts";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HEALTH_PATH } from "./paths";
import { users } from "./users";

export function createApp() {
  const app = new Hono();
  app.use("*", cors());
  app.use("/api/*", async (_c, next) => {
    await next();
  });
  app.get(HEALTH_PATH, (c) => c.text("ok"));
  app.route("/api", posts);
  app.route("/api/users", users);
  return app;
}

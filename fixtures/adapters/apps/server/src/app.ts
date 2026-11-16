import { appRouter } from "@demo/api";
import { posts } from "@demo/posts";
import { RPCHandler } from "@orpc/server/fetch";
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
  app.use("/rpc/*", async (c, next) => {
    const handler = new RPCHandler(appRouter);
    const { matched, response } = await handler.handle(c.req.raw, { context: {} });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });
  return app;
}

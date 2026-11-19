import autoload from "@fastify/autoload";
import Fastify, { type FastifyInstance } from "fastify";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getStats } from "./controllers/stats";
import { getVersion } from "./controllers/version";
import { VERSION_PATH } from "./paths";
import dbPlugin from "./plugins/db";
import { postsRoutes } from "./routes/posts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The path is built from the `name` parameter, so no static analysis can know it.
function registerFeature(app: FastifyInstance, name: string) {
  app.get(`/api/features/${name}`, async () => ({ feature: name }));
}

export async function buildApp() {
  const app = Fastify();
  await app.register(dbPlugin);
  app.register(postsRoutes, { prefix: "/api/posts" });
  app.route({ method: ["GET", "HEAD"], url: "/api/stats", handler: getStats });
  app.get(VERSION_PATH, getVersion);
  registerFeature(app, "flags");
  app.register(autoload, { dir: join(__dirname, "autoroutes"), options: { prefix: "/api" } });
  return app;
}

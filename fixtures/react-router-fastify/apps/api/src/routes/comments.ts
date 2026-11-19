import type { FastifyInstance } from "fastify";
import { addComment, listComments } from "../controllers/comments";

export async function commentsRoutes(app: FastifyInstance) {
  app.get("/", listComments);
  app.post("/", addComment);
}

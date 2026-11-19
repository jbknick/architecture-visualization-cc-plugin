import type { FastifyInstance } from "fastify";
import { createPost, deletePost, getPost, listPosts, updatePost } from "../controllers/posts";
import { createPostSchema } from "../schemas";
import { commentsRoutes } from "./comments";

export async function postsRoutes(app: FastifyInstance) {
  app.get("/", listPosts);
  app.post("/", { schema: createPostSchema }, createPost);
  app.get("/:postId", getPost);
  app.put("/:postId", updatePost);
  app.delete("/:postId", deletePost);
  app.register(commentsRoutes, { prefix: "/:postId/comments" });
}

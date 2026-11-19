import * as db from "@acme-rrf/db";
import type { FastifyReply, FastifyRequest } from "fastify";

type PostParams = { Params: { postId: string } };

export async function listPosts() {
  return db.listPosts();
}

export async function getPost(req: FastifyRequest<PostParams>) {
  return db.getPost(req.params.postId);
}

export async function createPost(
  req: FastifyRequest<{ Body: { title: string } }>,
  reply: FastifyReply,
) {
  await db.createPost({ title: req.body.title, authorId: "anonymous" });
  return reply.code(201).send();
}

export async function updatePost(req: FastifyRequest<PostParams & { Body: { title: string } }>) {
  return db.updatePost(req.params.postId, req.body.title);
}

export async function deletePost(req: FastifyRequest<PostParams>) {
  return db.deletePost(req.params.postId);
}

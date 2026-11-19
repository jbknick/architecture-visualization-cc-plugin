import * as db from "@acme-rrf/db";
import type { FastifyRequest } from "fastify";

type CommentParams = { Params: { postId: string } };

export async function listComments(req: FastifyRequest<CommentParams>) {
  return db.listComments(req.params.postId);
}

export async function addComment(
  req: FastifyRequest<CommentParams & { Body: { authorId: string; body: string } }>,
) {
  return db.addComment(req.params.postId, req.body);
}

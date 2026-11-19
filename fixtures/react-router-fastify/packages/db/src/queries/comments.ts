import { eq } from "drizzle-orm";
import { db } from "../client";
import { comments, users } from "../schema";

export async function listComments(postId: string) {
  return db
    .select({ id: comments.id, body: comments.body, author: users.name })
    .from(comments)
    .innerJoin(users, eq(comments.authorId, users.id))
    .where(eq(comments.postId, postId));
}

export async function addComment(postId: string, input: { authorId: string; body: string }) {
  return db.insert(comments).values({ id: crypto.randomUUID(), postId, ...input });
}

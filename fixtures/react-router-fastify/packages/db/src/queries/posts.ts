import { eq } from "drizzle-orm";
import { db } from "../client";
import { posts } from "../schema";

export async function listPosts() {
  return db.select().from(posts);
}

export async function getPost(id: string) {
  return db.select().from(posts).where(eq(posts.id, id));
}

export async function createPost(input: { title: string; authorId: string }) {
  return db.insert(posts).values({ id: crypto.randomUUID(), createdAt: new Date(), ...input });
}

export async function updatePost(id: string, title: string) {
  return db.update(posts).set({ title }).where(eq(posts.id, id));
}

export async function deletePost(id: string) {
  return db.delete(posts).where(eq(posts.id, id));
}

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { posts } from "./schema";

const db = drizzle(":memory:");

export async function listPosts() {
  return db.select().from(posts);
}

export async function getPost(id: string) {
  return db.select().from(posts).where(eq(posts.id, id));
}

export async function createPost(input: { title: string; authorId: string }) {
  return db.insert(posts).values({ id: crypto.randomUUID(), createdAt: Date.now(), ...input });
}

import { eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Db } from "./client";
import * as schema from "./schema";
import { posts, users } from "./schema";

export async function listPosts(db: Db) {
  return db.query.posts.findMany({ limit: 20 });
}

export async function postWithAuthor(db: Db, id: string) {
  const author = alias(users, "author");
  return db
    .select()
    .from(posts)
    .innerJoin(author, eq(posts.authorId, author.id))
    .where(eq(posts.id, id));
}

export async function createPost(db: Db, input: { title: string; authorId: string }) {
  return db.insert(posts).values({ id: crypto.randomUUID(), views: 0, ...input });
}

export async function renameUser(db: Db, id: string, name: string) {
  await db.transaction(async (tx) => {
    await tx.update(schema.users).set({ name }).where(eq(users.id, id));
  });
}

export async function deletePost(db: Db, id: string) {
  return db.delete(posts).where(eq(posts.id, id));
}

export async function countUsers(db: Db) {
  return db.$count(users);
}

// Raw SQL is not read: no edge for this function.
export async function rawPostCount(db: Db) {
  return db.run(sql`select count(*) from posts`);
}

// Not a query: `Array.from` on a table binding is no read.
export function columnsOf() {
  return Array.from(Object.keys(posts));
}

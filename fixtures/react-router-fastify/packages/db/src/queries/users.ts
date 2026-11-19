import { eq } from "drizzle-orm";
import { db } from "../client";
import { users } from "../schema";

export async function listUsers() {
  return db.select().from(users);
}

export async function getUser(id: string) {
  return db.select().from(users).where(eq(users.id, id));
}

export async function createUser(input: { name: string }) {
  return db.insert(users).values({ id: crypto.randomUUID(), ...input });
}

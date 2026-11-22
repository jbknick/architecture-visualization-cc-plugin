import { eq } from "drizzle-orm";
import { db } from "./client";
import { orders, users } from "./schema";

export const findUser = (id: string) => db.select().from(users).where(eq(users.id, id));

export const findOrder = (id: string) => db.select().from(orders).where(eq(orders.id, id));

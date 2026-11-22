import { eq } from "drizzle-orm";
import { db } from "./client";
import { invoices } from "./schema";

export const findInvoice = (id: string) => db.select().from(invoices).where(eq(invoices.id, id));

export const insertInvoice = (customerId: string) =>
  db.insert(invoices).values({ id: crypto.randomUUID(), customerId });

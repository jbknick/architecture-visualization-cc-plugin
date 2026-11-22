import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const invoices = sqliteTable("invoices", {
  id: text("id").primaryKey(),
  customerId: text("customer_id").notNull(),
});

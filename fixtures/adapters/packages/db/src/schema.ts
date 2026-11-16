import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

export const posts = sqliteTable("posts", (t) => ({
  id: t.text("id").primaryKey(),
  title: t.text("title").notNull(),
  authorId: t.text("author_id").notNull(),
  views: integer("views").notNull(),
}));

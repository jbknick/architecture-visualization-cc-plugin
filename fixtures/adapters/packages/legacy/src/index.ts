// This package declares none of hono, TanStack Start, @orpc/server or drizzle-orm, so no adapter reads it.
import { createServerFn } from "@tanstack/react-start";
import { os } from "@orpc/server";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";

export const legacy = new Hono();
legacy.get("/legacy", (c) => c.text("legacy"));

export const legacyFn = createServerFn().handler(async () => "legacy");

export const legacyRows = sqliteTable("legacy_rows", { id: text("id") });
export const legacyRouter = { ping: os.handler(() => "pong") };
export const readLegacy = (db: { select(): { from(t: unknown): unknown } }) => db.select().from(legacyRows);

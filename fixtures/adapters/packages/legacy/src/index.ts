// This package declares neither hono nor TanStack Start, so neither adapter reads it.
import { createServerFn } from "@tanstack/react-start";
import { Hono } from "hono";

export const legacy = new Hono();
legacy.get("/legacy", (c) => c.text("legacy"));

export const legacyFn = createServerFn().handler(async () => "legacy");

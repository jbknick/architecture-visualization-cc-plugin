import { Hono } from "hono";

// A test harness app: test files are skipped, so this is not an endpoint.
export const harness = new Hono();
harness.get("/only-in-tests", (c) => c.text("test"));

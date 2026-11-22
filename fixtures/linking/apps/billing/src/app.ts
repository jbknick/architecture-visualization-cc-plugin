import { Hono } from "hono";

export const app = new Hono();
app.get("/health", (c) => c.text("ok"));
app.get("/invoices/:id", (c) => c.json({}));
app.post("/invoices", (c) => c.json({}));

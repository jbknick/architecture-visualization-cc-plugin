import { Hono } from "hono";
import { createInvoiceHandler, getInvoiceHandler } from "./handlers";

export const app = new Hono();
app.get("/health", (c) => c.text("ok"));
app.get("/invoices/:id", getInvoiceHandler);
app.post("/invoices", createInvoiceHandler);

import type { Context } from "hono";
import { findInvoice, insertInvoice } from "./db/queries";

export async function getInvoiceHandler(c: Context) {
  return c.json(await findInvoice(c.req.param("id")));
}

export async function createInvoiceHandler(c: Context) {
  return c.json(await insertInvoice("customer"));
}

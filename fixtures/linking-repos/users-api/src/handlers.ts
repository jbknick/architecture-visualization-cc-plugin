import type { Context } from "hono";
import { findOrder, findUser } from "./db/queries";

export async function getUserHandler(c: Context) {
  return c.json(await findUser(c.req.param("id")));
}

export async function getOrderHandler(c: Context) {
  return c.json(await findOrder(c.req.param("id")));
}

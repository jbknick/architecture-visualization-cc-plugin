import { Hono } from "hono";

type Ctx = { json(value: unknown, status?: number): Response };

function listUsers(c: Ctx) {
  return c.json([]);
}

function createUser(c: Ctx) {
  return c.json({ created: true }, 201);
}

export const users = new Hono().basePath("/v1").get("/", listUsers).post(createUser);

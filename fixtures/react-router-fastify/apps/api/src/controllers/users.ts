import * as db from "@acme-rrf/db";
import type { FastifyRequest } from "fastify";

export async function listUsers() {
  return db.listUsers();
}

export async function getUser(req: FastifyRequest<{ Params: { userId: string } }>) {
  return db.getUser(req.params.userId);
}

export async function createUser(req: FastifyRequest<{ Body: { name: string } }>) {
  return db.createUser({ name: req.body.name });
}

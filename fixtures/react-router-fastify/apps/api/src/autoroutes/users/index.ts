import type { FastifyInstance } from "fastify";
import { createUser, getUser, listUsers } from "../../controllers/users";

// @fastify/autoload adds "/users" from the directory name, after the "/api" option prefix.
export default async function usersRoutes(app: FastifyInstance) {
  app.get("/", listUsers);
  app.post("/", createUser);
  app.get("/:userId", getUser);
}

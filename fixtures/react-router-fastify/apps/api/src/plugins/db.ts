import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { db } from "@acme-rrf/db";

export default fp(async (app: FastifyInstance) => {
  app.decorate("db", db);
});

import type { Db } from "@demo/db";
import { ORPCError, os } from "@orpc/server";

export interface Context {
  db: Db;
  userId?: string;
}

export const pub = os.$context<Context>();

const requireUser = pub.middleware(({ context, next }) => {
  if (!context.userId) throw new ORPCError("UNAUTHORIZED");
  return next({ context: { userId: context.userId } });
});

export const authed = pub.use(requireUser);

import { deletePost } from "@demo/db";
import { authed } from "../base";

/** A router built by a factory of the same file. */
function makeAdminRouter(reason: string) {
  return {
    purgePost: authed.handler(async ({ context, input }) => {
      await deletePost(context.db, (input as { id: string }).id);
      return { reason };
    }),
  };
}

export const adminRouter = makeAdminRouter("moderation");

import { countUsers, renameUser } from "@demo/db";
import { authed, pub } from "../base";

export const countUsersProc = pub.handler(async ({ context }) => countUsers(context.db));

export const usersRouter = authed.router({
  count: countUsersProc,
  rename: authed.handler(async ({ context, input }) => {
    const { id, name } = input as { id: string; name: string };
    await renameUser(context.db, id, name);
  }),
});

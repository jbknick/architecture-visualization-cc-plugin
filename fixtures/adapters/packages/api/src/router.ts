import { os } from "@orpc/server";
import { adminRouter } from "./routers/admin";
import { postsRouter } from "./routers/posts";
import { usersRouter } from "./routers/users";

export const appRouter = {
  posts: postsRouter,
  admin: adminRouter,
  users: usersRouter,
  stats: os.lazy(() => import("./routers/stats")),
  health: os.handler(() => "ok"),
};

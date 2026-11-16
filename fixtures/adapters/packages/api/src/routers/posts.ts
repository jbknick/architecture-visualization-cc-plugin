import { countUsers, createPost, deletePost, listPosts, postWithAuthor } from "@demo/db";
import { authed, pub } from "../base";

const postInput = { parse: (v: unknown) => v as { title: string; authorId: string } };

async function removePost({ context, input }: { context: { db: never }; input: { id: string } }) {
  return deletePost(context.db, input.id);
}

// Inline handlers share this const: a trace from one procedure follows only the calls inside its own handler.
export const postsRouter = {
  list: pub.route({ method: "GET", path: "/posts" }).handler(async ({ context }) => listPosts(context.db)),
  get: pub.handler(async ({ context, input }) => postWithAuthor(context.db, (input as { id: string }).id)),
  authors: pub.handler(async ({ context }) => countUsers(context.db)),
  create: authed.input(postInput).handler(async ({ context, input }) => createPost(context.db, input)),
  remove: authed.handler(removePost),
};

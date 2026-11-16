import { createPost, deletePost, listPosts } from "@demo/db";
import { authed, pub } from "../base";

const postInput = { parse: (v: unknown) => v as { title: string; authorId: string } };

async function removePost({ context, input }: { context: { db: never }; input: { id: string } }) {
  return deletePost(context.db, input.id);
}

export const postsRouter = {
  list: pub.route({ method: "GET", path: "/posts" }).handler(async ({ context }) => listPosts(context.db)),
  create: authed.input(postInput).handler(async ({ context, input }) => createPost(context.db, input)),
  remove: authed.handler(removePost),
};

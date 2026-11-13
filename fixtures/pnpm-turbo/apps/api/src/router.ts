import { os } from "@orpc/server";
import { createPost, listPosts } from "@acme/db";

export const router = {
  posts: {
    list: os.handler(async () => listPosts()),
    create: os.handler(async ({ input }) => createPost(input as { title: string; authorId: string })),
  },
};

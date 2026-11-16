import { createServerFn } from "@tanstack/react-start";

type Post = { id: string; title: string };

async function loadPost(id: string): Promise<Post> {
  return { id, title: `Post ${id}` };
}

function requireUser() {
  return { userId: "u1" };
}

export const fetchPost = createServerFn({ method: "GET" })
  .inputValidator((id: string) => id)
  .handler(async ({ data }) => loadPost(data));

async function savePostHandler({ data }: { data: Post }) {
  return data;
}

export const savePost = createServerFn({ method: "POST" }).middleware([requireUser]).handler(savePostHandler);

import { listPosts } from "@acme-rrf/db";

export async function getStats() {
  const posts = await listPosts();
  return { posts: posts.length };
}

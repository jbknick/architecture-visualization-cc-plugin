import { client } from "./orpc";

// A sub-client alias: calls through it are matched with its prefix (posts.list).
export const postsClient = client.posts;

// Only passed on as a value, so its calls happen out of sight: reported as a client alias.
export const usersClient = client.users;

export function listPostsNow() {
  return postsClient.list();
}

export function withUsers(c = usersClient) {
  return c;
}

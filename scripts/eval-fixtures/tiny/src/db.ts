export const posts = { name: "posts" };
export const users = { name: "users" };

export function getPost(id: string) {
  return { table: posts, id };
}

export function listUsers() {
  return { table: users };
}

export function createPost(title: string) {
  return { table: posts, title };
}

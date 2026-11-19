import { createPost, getPost } from "./db";

export const routes = {
  "GET /posts/:id": (id: string) => getPost(id),
  "POST /posts": (title: string) => createPost(title),
};

export const loadPost = (id: string) => fetch(`/posts/${id}`);

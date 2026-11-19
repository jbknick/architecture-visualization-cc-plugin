import { Route, Routes } from "react-router";
import { NewPost } from "./NewPost";
import { PostDetail } from "./PostDetail";
import { PostList } from "./PostList";

export function PostsSection() {
  return (
    <Routes>
      <Route index element={<PostList />} />
      <Route path=":postId" element={<PostDetail />} />
      <Route path="new" element={<NewPost />} />
    </Routes>
  );
}

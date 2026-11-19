import { createMemoryRouter } from "react-router";
import { PostDetail } from "./pages/PostDetail";
import { PostList } from "./pages/PostList";

export const previewRouter = createMemoryRouter(
  [
    { path: "/preview", element: <PostList /> },
    { path: "/preview/:postId", element: <PostDetail /> },
  ],
  { initialEntries: ["/preview"] },
);

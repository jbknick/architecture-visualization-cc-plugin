import { createBrowserRouter } from "react-router";
import { AuthLayout, RootLayout } from "./layouts";
import { Comments } from "./pages/Comments";
import { Home } from "./pages/Home";
import { Login } from "./pages/Login";
import { NewPost } from "./pages/NewPost";
import { NotFound } from "./pages/NotFound";
import { PostDetail } from "./pages/PostDetail";
import { PostList } from "./pages/PostList";
import { PostsLayout } from "./pages/PostsLayout";
import { Register } from "./pages/Register";

export const router = createBrowserRouter([
  {
    path: "/app",
    element: <RootLayout />,
    children: [
      { index: true, element: <Home /> },
      {
        path: "posts",
        element: <PostsLayout />,
        children: [
          { index: true, element: <PostList /> },
          {
            path: ":postId",
            element: <PostDetail />,
            children: [{ path: "comments", Component: Comments }],
          },
          { path: "new", element: <NewPost /> },
        ],
      },
      {
        element: <AuthLayout />,
        children: [
          { path: "signin", element: <Login /> },
          { path: "signup", element: <Register /> },
        ],
      },
      { path: "settings", lazy: () => import("./routes/settings") },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

import { BrowserRouter, Route, Routes } from "react-router";
import { About } from "./pages/About";
import { Home } from "./pages/Home";
import { Layout } from "./pages/Layout";
import { NotFound } from "./pages/NotFound";
import { PostsSection } from "./pages/PostsSection";
import { UserProfile } from "./pages/UserProfile";
import { Users } from "./pages/Users";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="docs">
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="about" element={<About />} />
            <Route path="posts/*" element={<PostsSection />} />
            <Route path="users" element={<Users />}>
              <Route path=":userId" element={<UserProfile />} />
            </Route>
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

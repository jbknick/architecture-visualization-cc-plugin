import { formatDate } from "@mr/contracts";
import { useEffect, useState } from "react";

interface Post {
  id: string;
  title: string;
  createdAt: string;
}

export function PostsPage() {
  const [posts, setPosts] = useState<Post[]>([]);
  useEffect(() => {
    fetch("/api/posts")
      .then((res) => res.json())
      .then((body: Post[]) => setPosts(body));
  }, []);
  return (
    <ul>
      {posts.map((p) => (
        <li key={p.id}>
          {p.title} <small>{formatDate(p.createdAt)}</small>
        </li>
      ))}
    </ul>
  );
}

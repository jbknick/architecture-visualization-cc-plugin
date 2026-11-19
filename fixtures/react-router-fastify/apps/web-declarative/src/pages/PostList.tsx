import { useEffect, useState } from "react";

export function PostList() {
  const [posts, setPosts] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    fetch("/api/posts")
      .then((r) => r.json())
      .then(setPosts);
  }, []);
  return <ul>{posts.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;
}

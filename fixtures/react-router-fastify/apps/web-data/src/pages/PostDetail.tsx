import { useEffect, useState } from "react";
import { Outlet, useParams } from "react-router";

export function PostDetail() {
  const { postId } = useParams();
  const [post, setPost] = useState<{ title: string } | null>(null);
  useEffect(() => {
    fetch(`/api/posts/${postId}`)
      .then((r) => r.json())
      .then(setPost);
  }, [postId]);
  return (
    <article>
      <h1>{post?.title}</h1>
      <Outlet />
    </article>
  );
}

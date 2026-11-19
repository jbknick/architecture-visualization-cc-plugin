import { useEffect, useState } from "react";
import { useParams } from "react-router";

export function PostDetail() {
  const { postId } = useParams();
  const [post, setPost] = useState<{ title: string } | null>(null);
  useEffect(() => {
    fetch(`/api/posts/${postId}`)
      .then((r) => r.json())
      .then(setPost);
  }, [postId]);
  return <h1>{post?.title}</h1>;
}

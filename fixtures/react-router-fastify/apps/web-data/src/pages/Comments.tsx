import { useEffect, useState } from "react";
import { useParams } from "react-router";

export function Comments() {
  const { postId } = useParams();
  const [comments, setComments] = useState<{ id: string; body: string }[]>([]);
  useEffect(() => {
    fetch(`/api/posts/${postId}/comments`)
      .then((r) => r.json())
      .then(setComments);
  }, [postId]);
  return <ul>{comments.map((c) => <li key={c.id}>{c.body}</li>)}</ul>;
}

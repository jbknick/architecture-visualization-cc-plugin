import type { LoaderFunctionArgs } from "react-router";

export async function loader({ params }: LoaderFunctionArgs) {
  const res = await fetch(`/api/posts/${params.articleId}`);
  return res.json();
}

export default function Article() {
  return <h1>Post</h1>;
}

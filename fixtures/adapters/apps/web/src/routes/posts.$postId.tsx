import { createFileRoute } from "@tanstack/react-router";
import { fetchPost } from "../server/posts";

export const Route = createFileRoute("/posts/$postId")({
  loader: ({ params }) => fetchPost({ data: params.postId }),
  component: PostPage,
});

function PostPage() {
  const post = Route.useLoaderData();
  return <article>{post.title}</article>;
}

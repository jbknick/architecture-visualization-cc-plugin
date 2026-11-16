import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PostActions } from "../components/PostActions";
import { orpc } from "../lib/orpc";
import { fetchPost } from "../server/posts";

export const Route = createFileRoute("/posts/$postId")({
  loader: ({ params }) => fetchPost({ data: params.postId }),
  component: PostPage,
});

function PostPage() {
  const post = Route.useLoaderData();
  const { postId } = Route.useParams();
  const { data } = useQuery(orpc.posts.get.queryOptions({ input: { id: postId } }));
  return (
    <article>
      {post.title} {data?.length}
      <PostActions id={postId} />
    </article>
  );
}

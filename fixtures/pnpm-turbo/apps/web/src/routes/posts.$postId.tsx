import { createFileRoute } from "@tanstack/react-router";
import { formatRelativeDate } from "@acme/utils";
import { posts } from "@acme/db";

export const Route = createFileRoute("/posts/$postId")({ component: PostPage });

function PostPage() {
  const { postId } = Route.useParams();
  return (
    <article>
      {postId} {formatRelativeDate(new Date())} {String(posts)}
    </article>
  );
}

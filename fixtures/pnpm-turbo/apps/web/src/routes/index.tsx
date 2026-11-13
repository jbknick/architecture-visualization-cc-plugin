import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@acme/ui/button";
import { PostList } from "../components/PostList";

export const Route = createFileRoute("/")({ component: HomePage });

function HomePage() {
  return (
    <section>
      <PostList />
      <Button label="New post" />
    </section>
  );
}

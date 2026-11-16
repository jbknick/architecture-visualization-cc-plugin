import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

const countPosts = createServerFn().handler(async () => 3);

export const Route = createFileRoute("/")({
  beforeLoad: checkCount,
  component: HomePage,
});

async function checkCount() {
  const n = await countPosts();
  return { n, at: Date.now() };
}

function HomePage() {
  return <section>Home</section>;
}

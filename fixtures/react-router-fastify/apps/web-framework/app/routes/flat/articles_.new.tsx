export async function action() {
  await fetch("/api/posts", { method: "POST" });
  return null;
}

export default function NewArticle() {
  return <h1>New post</h1>;
}

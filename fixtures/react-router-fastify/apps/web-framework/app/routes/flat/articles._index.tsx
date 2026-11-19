export async function loader() {
  const res = await fetch("/api/posts");
  return res.json();
}

export default function ArticleIndex() {
  return <h1>Posts</h1>;
}

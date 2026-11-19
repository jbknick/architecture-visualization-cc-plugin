export async function loader() {
  const res = await fetch("/api/posts");
  return res.json();
}

export default function Dashboard() {
  return <h1>Dashboard</h1>;
}

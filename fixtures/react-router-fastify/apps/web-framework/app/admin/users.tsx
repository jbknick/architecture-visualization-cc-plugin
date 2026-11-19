export async function loader() {
  const res = await fetch("/api/users");
  return res.json();
}

export default function AdminUsers() {
  return <h1>Users</h1>;
}

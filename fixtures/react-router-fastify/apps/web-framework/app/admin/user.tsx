import type { LoaderFunctionArgs } from "react-router";

export async function loader({ params }: LoaderFunctionArgs) {
  const res = await fetch(`/api/users/${params.userId}`);
  return res.json();
}

export default function AdminUser() {
  return <h1>User</h1>;
}

import { useEffect, useState } from "react";
import { Outlet } from "react-router";

export function Users() {
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    fetch("/api/users")
      .then((r) => r.json())
      .then(setUsers);
  }, []);
  async function add(name: string) {
    await fetch("/api/users", { method: "POST", body: JSON.stringify({ name }) });
  }
  return (
    <section>
      <button onClick={() => add("Grace")}>Add</button>
      <ul>{users.map((u) => <li key={u.id}>{u.name}</li>)}</ul>
      <Outlet />
    </section>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { client } from "../lib/orpc";

export const Route = createFileRoute("/users")({ component: UsersPage });

async function loadCount() {
  return client.users.count();
}

function UsersPage() {
  void loadCount();
  return <section>Users</section>;
}

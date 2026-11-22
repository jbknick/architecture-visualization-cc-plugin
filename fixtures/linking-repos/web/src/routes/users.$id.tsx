import { createFileRoute } from "@tanstack/react-router";
import { loadUser } from "../features/users";

export const Route = createFileRoute("/users/$id")({ component: UserPage });

function UserPage() {
  const { id } = Route.useParams();
  loadUser(id);
  return <h1>User {id}</h1>;
}

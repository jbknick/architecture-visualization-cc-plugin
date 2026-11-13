import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@acme/ui";

export const Route = createFileRoute("/settings/profile")({ component: ProfilePage });

function ProfilePage() {
  return <Card title="Profile" />;
}

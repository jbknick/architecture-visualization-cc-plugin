import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@acme/ui/button";
import { Card } from "@acme/ui";

export const Route = createFileRoute("/settings/profile")({ component: ProfilePage });

function ProfilePage() {
  return (
    <div>
      <Card title="Profile" />
      <Button label="Save" />
    </div>
  );
}

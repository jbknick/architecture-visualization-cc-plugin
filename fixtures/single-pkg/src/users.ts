import type { User } from "@/types";

export function findUser(users: User[], id: string): User | undefined {
  return users.find((u) => u.id === id);
}

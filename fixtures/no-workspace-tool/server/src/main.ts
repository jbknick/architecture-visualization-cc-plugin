import { greet } from "@plain/shared";

export function serve(name: string): string {
  return greet(name).toUpperCase();
}

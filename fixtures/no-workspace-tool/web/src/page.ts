import { greet } from "@plain/shared";

export function render(name: string): string {
  return `<h1>${greet(name)}</h1>`;
}

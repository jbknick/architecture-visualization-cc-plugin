import { formatName } from "@/util/format";

export default function greet(first: string, last: string): string {
  const name = formatName(first, last);
  return `Hello, ${name}!`;
}

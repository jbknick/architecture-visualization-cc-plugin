import { money } from "@/lib/format";

export function summary(cents: number): string {
  return money(cents);
}

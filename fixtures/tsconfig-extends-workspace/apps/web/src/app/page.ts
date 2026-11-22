import { money } from "@/lib/format";
import { isoDay } from "~shared/date";

export function summary(cents: number, at: Date): string {
  return `${money(cents)} on ${isoDay(at)}`;
}

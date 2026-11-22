import { isoDay } from "~shared/date";

export function today(at: Date): string {
  return isoDay(at);
}

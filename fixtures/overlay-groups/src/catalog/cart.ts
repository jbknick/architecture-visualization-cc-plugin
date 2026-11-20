import { totalDue } from "../orders/invoice";

export function cartTotal(items: number[]): number {
  return totalDue(items);
}

import { formatLine, parseLine } from "@refs/core";
import { padLeft } from "../../../packages/util/src/strings";

export function main(input: string): string {
  const cells = parseLine(input).map((cell) => padLeft(cell, 8));
  return formatLine(cells);
}

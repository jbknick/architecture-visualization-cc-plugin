export function parseLine(line: string): string[] {
  return line.split(",").map((cell) => cell.trim());
}

export function formatLine(cells: string[]): string {
  return cells.join(", ");
}

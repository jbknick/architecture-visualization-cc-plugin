/**
 * Helper `method-classes`: which methods on a receiver read a table and which write it. The recipe states the two
 * lists; the helper only classifies a method name against them. A method in both lists is a write (a call that
 * changes the row and returns it changes data). A method in neither is no access.
 */

export interface MethodClasses {
  read?: readonly string[];
  write?: readonly string[];
}

export type MethodClass = "read" | "write";

export function classifyMethod(method: string, classes: MethodClasses | undefined): MethodClass | null {
  if (!classes) return null;
  if (classes.write?.includes(method)) return "write";
  if (classes.read?.includes(method)) return "read";
  return null;
}

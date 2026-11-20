/**
 * Helper `model-naming`: the table a model, entity, collection or struct name stands for. The recipe states how:
 * an `explicit` map from model name to table name, and whether a model with no entry is its table's `snake_case`
 * name, its plural, or both. Nothing here names an ORM; which names are models is the recipe's business.
 */

export interface ModelNaming {
  /** Model name to table name. */
  explicit?: Record<string, string>;
  /** `UserAccount` is table `user_account`. */
  snakeCase?: boolean;
  /** `User` is table `users`, `Category` is `categories`. */
  plural?: boolean;
}

export function snakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

export function pluralize(s: string): string {
  if (/(?:s|x|z|ch|sh)$/.test(s)) return `${s}es`;
  if (/[^aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`;
  return `${s}s`;
}

/** The table names a model may have, most specific first: the explicit entry, the name itself, then the derived ones. */
export function tableCandidates(model: string, naming: ModelNaming | undefined): string[] {
  const out: string[] = [];
  const push = (n: string | undefined): void => {
    if (n && !out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
  };
  push(naming?.explicit?.[model]);
  push(model);
  const snake = naming?.snakeCase ? snakeCase(model) : undefined;
  push(snake);
  if (naming?.plural) {
    push(pluralize(model));
    if (snake) push(pluralize(snake));
  }
  return out;
}

/** Model names compare without case or punctuation (`UserAccount`, `user_account`, `useraccount`). */
export const normalizeModel = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

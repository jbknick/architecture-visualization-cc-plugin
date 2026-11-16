import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb(binding: unknown) {
  return drizzle(binding as never, { schema });
}

export type Db = ReturnType<typeof getDb>;

// A schema module the resolver cannot find: the table binding is matched by name only (low confidence).
import { posts } from "@demo/db/generated-schema";

export function reportPosts(db: { select(): { from(t: unknown): unknown } }) {
  return db.select().from(posts);
}

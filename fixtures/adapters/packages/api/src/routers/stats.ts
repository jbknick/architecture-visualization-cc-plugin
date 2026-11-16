import { countUsers } from "@demo/db";
import { oc } from "@orpc/contract";
import { implement } from "@orpc/server";

export const statsContract = { summary: oc.route({ method: "GET", path: "/stats" }) };

const impl = implement(statsContract);

export default {
  summary: impl.summary.handler(async () => ({ users: await countUsers(undefined as never) })),
};

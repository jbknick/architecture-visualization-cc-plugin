import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

// The client is built by a local function, as apps often do to configure the link.
const makeClient = () => createORPCClient(new RPCLink({ url: "/rpc" }));

export const client = makeClient();
export const orpc = createTanstackQueryUtils(client);

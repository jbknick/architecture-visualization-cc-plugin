import { clientsAdapter } from "./clients.js";
import { drizzleAdapter } from "./drizzle.js";
import { type Adapter, type AdapterOutput, type AdapterRunContext, runAdapterList } from "./framework.js";
import { honoAdapter } from "./hono.js";
import { orpcAdapter } from "./orpc.js";
import { tanstackRoutesAdapter } from "./tanstack-routes.js";
import { tanstackStartAdapter } from "./tanstack-start.js";

export * from "./clients.js";
export * from "./drizzle.js";
export * from "./framework.js";
export * from "./hono.js";
export * from "./orpc.js";
export * from "./tanstack-routes.js";
export * from "./tanstack-start.js";

/**
 * The registered adapters, in run order. Routes come first so later links (a loader calling a server function,
 * client calls matched to endpoints) can see the route nodes; oRPC follows Hono so a router's mount can read the
 * Hono node registered on the same line. Client-call matching runs last, after every endpoint is known.
 */
export const ADAPTERS: readonly Adapter<unknown>[] = [
  tanstackRoutesAdapter,
  tanstackStartAdapter,
  honoAdapter,
  orpcAdapter,
  drizzleAdapter,
  // Last: client calls are matched against the endpoints every other adapter found.
  clientsAdapter,
];

/** Runs the registered adapters (`ADAPTERS`) over the files; see `runAdapterList`. */
export function runAdapters(ctx: AdapterRunContext): AdapterOutput {
  return runAdapterList(ctx, ADAPTERS);
}

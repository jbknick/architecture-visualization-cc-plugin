import { hc } from "hono/client";

type AppType = Record<string, unknown>;

export const api = hc<AppType>("/");

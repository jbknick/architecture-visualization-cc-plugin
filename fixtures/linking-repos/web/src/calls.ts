import { hc } from "hono/client";

export const client = hc("/");

export const listUsers = () => fetch("/api/users");
export const getUser = (id: string) => fetch(`/api/users/${id}`);
export const createInvoice = () => fetch("/invoices", { method: "POST" });
export const health = () => fetch("/health");
export const nothing = () => fetch("/api/nothing");
export const fromEnv = () => fetch(`${process.env.API_URL}/api/users`);
export const outside = () => fetch("https://example.com/api/users");
export function typed() {
  return client.api.users.$get();
}

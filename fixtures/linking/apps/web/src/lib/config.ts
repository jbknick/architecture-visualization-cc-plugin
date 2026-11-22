export const API_URL = import.meta.env.VITE_API_URL;
export const BILLING_URL: string = import.meta.env.VITE_BILLING_URL ?? "http://localhost:4000";
export const ROUTES = {
  me: "/users/me",
  invoices: "/invoices",
} as const;
export enum Paths {
  Users = "/users",
  Orders = "/orders",
}

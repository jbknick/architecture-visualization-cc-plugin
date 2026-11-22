import axios from "axios";
import { hc } from "hono/client";
import ky from "ky";

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

const BASE = "/api";

enum Route {
  Invoices = "/invoices",
}

export const api = axios.create({ baseURL: "/api" });
export const kyApi = ky.create({ prefixUrl: "/api" });

function request(path: string, init?: RequestInit) {
  return fetch(path, init);
}

export const viaAxios = () => api.get("/users");
export const viaKy = () => kyApi.post("users");
export const viaWrapper = () => request("/invoices/7");
export const viaConst = () => fetch(`${BASE}/users/1`);
export const viaEnum = () => fetch(Route.Invoices, { method: "POST" });

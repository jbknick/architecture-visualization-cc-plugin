import axios from "axios";
import ky from "ky";
import { API_URL } from "./config";

export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL });
export const billing = axios.create({ baseURL: process.env.BILLING_URL });
export const kyApi = ky.create({ prefixUrl: API_URL });

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  return (await res.json()) as T;
}

export function request(method: string, path: string, body?: unknown) {
  return api.request({ url: path, method, data: body });
}

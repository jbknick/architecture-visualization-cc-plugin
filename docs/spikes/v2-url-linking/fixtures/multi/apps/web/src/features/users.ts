import { API_URL, BILLING_URL, Paths, ROUTES } from "../lib/config";
import { api, apiFetch, billing, kyApi, request } from "../lib/http";

export async function envTemplate(id: string) {
  return fetch(`${process.env.API_URL}/users/${id}`);
}

export async function viteEnvPost(body: string) {
  return fetch(`${import.meta.env.VITE_API_URL}/users`, { method: "POST", body });
}

export async function concatenated(id: string) {
  return fetch(API_URL + "/users/" + id);
}

export async function axiosInstance(id: string) {
  await api.get(`/users/${id}`);
  await api.delete(`/users/${id}`);
  return api.put(`/users/${id}`, {});
}

export async function kyPrefix(id: string) {
  return kyApi.get(`users/${id}`).json();
}

export async function wrapper(id: string) {
  await apiFetch(`/users/${id}`);
  return apiFetch("/users", { method: "POST" });
}

export async function wrapperWithMethodArg(id: string) {
  return request("PUT", `/users/${id}`, {});
}

export async function constUrl(id: string) {
  const url = `${API_URL}/orders/${id}`;
  return fetch(url);
}

export async function newUrl(id: string) {
  const u = new URL(`/orders/${id}`, API_URL);
  return fetch(u);
}

export async function enumPath() {
  return api.get(Paths.Users);
}

export async function constObjectPath() {
  return api.get(ROUTES.me);
}

export async function otherBackend(id: string) {
  await fetch(`${BILLING_URL}/health`);
  return billing.get(`/invoices/${id}`);
}

export async function sameRouteTwoBackends() {
  return fetch(`${API_URL}/health`);
}

export async function relativeProxy() {
  return fetch("/api/users");
}

export async function nestedParams(postId: string) {
  return api.get(`/posts/${postId}/comments?limit=10`);
}

export async function fullyDynamic(resource: string, id: string) {
  return fetch(`${API_URL}/${resource}/${id}`);
}

export async function fromProps(endpoint: string) {
  return fetch(endpoint);
}

export async function external() {
  return fetch("https://api.github.com/repos/a/b");
}

export async function axiosConfig(id: string) {
  return api({ url: `/users/${id}`, method: "delete" });
}

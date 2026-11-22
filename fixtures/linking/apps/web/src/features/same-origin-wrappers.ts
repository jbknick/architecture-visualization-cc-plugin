import { getUser, relFetch, relRequest, useRelFetch } from "../lib/same-origin-http";
import { send } from "../lib/opaque";

export async function wGet(id: string) {
  return relFetch(`/users/${id}`);
}

export async function wPost() {
  return relFetch("/users", { method: "POST" });
}

export async function wMethod(id: string) {
  return relRequest("DELETE", `/users/${id}`);
}

export async function wHook() {
  return useRelFetch("/users/me");
}

export async function wUser() {
  return getUser("1");
}

export async function wSend() {
  return send("/users");
}

import { rel } from "../lib/same-origin-http";
import { API, REL, RelPaths } from "../lib/same-origin-config";

export async function cConst(id: string) {
  const url = `${API}/orders/${id}`;
  return fetch(url);
}

export async function cEnum() {
  return rel.get(RelPaths.Users);
}

export async function cAsConst() {
  return rel.get(REL.me);
}

export async function cConcat(id: string) {
  return fetch(API + "/users/" + id);
}

export async function cNullish() {
  return fetch((import.meta.env.VITE_REL ?? "/api") + "/users");
}

export async function cCond(id: string) {
  return fetch(
    import.meta.env.PROD ? `${import.meta.env.VITE_API_URL}/users/${id}` : `/api/users/${id}`,
  );
}

export async function cNewUrl(id: string) {
  return fetch(new URL(`/orders/${id}`, `${location.origin}/api/`));
}

export async function cTwoBackends() {
  return fetch("/health");
}

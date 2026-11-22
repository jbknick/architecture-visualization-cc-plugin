import { kyRel, kyRelAuth, rel } from "../lib/same-origin-http";

export async function instGet(id: string) {
  return rel.get(`/users/${id}`);
}

export async function instPost(b: unknown) {
  return rel.post("/users", b);
}

export async function instRequest() {
  return rel.request({ url: "/users/me", method: "get" });
}

export async function instCall(id: string) {
  return rel({ url: `/orders/${id}` });
}

export async function kyGet(id: string) {
  return kyRel.get(`users/${id}`).json();
}

export async function kyExtended(id: string) {
  return kyRelAuth.delete(`users/${id}`);
}

export async function instMissing() {
  return rel.get("/nope");
}

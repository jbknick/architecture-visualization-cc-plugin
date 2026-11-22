import axios from "axios";
import ky from "ky";

export const rel = axios.create({ baseURL: "/api" });
export const kyRel = ky.create({ prefixUrl: "/api" });
export const kyRelAuth = kyRel.extend({ headers: { a: "1" } });

export function relFetch(path: string, init?: RequestInit) {
  return fetch(`/api${path}`, init);
}

export function relRequest(method: string, path: string) {
  return rel.request({ url: path, method });
}

export function useRelFetch(path: string) {
  return relFetch(path);
}

export function getUser(id: string) {
  return rel.get(`/users/${id}`);
}

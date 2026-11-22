import { rel } from "../lib";

export async function viaReexport(id: string) {
  return rel.put(`/users/${id}`, {});
}

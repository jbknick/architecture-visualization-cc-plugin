import axios from "axios";

export async function defGet(id: string) {
  return axios.get(`/users/${id}`);
}

export async function defConfig() {
  return axios({ url: "/users", method: "post" });
}

export async function defRelative() {
  return axios.get("users/me");
}

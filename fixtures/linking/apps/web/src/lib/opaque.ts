import { joinUrl } from "url-join-lib";

export function send(path: string) {
  return fetch(joinUrl(path));
}

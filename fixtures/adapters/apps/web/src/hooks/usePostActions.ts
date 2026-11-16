import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { api } from "../lib/api";
import { orpc } from "../lib/orpc";
import { savePost } from "../server/posts";

export function usePostActions(id: string) {
  const queryClient = useQueryClient();
  const save = useServerFn(savePost);
  const remove = useMutation(orpc.posts.remove.mutationOptions());
  // No procedure is called archive: reported as unmatched, never guessed.
  const archive = useMutation(orpc.posts.archive.mutationOptions());
  // A router prefix is a cache helper, not a request.
  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.posts.key() });
  const show = () => api.api.posts[":id"].$get({ param: { id } });
  const touch = () => fetch(`/api/posts/${id}`, { method: "PATCH" });
  const ping = () => fetch("https://status.example.com/ping");
  return { save, remove, archive, refresh, show, touch, ping };
}

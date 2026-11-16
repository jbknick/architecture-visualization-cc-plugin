import { usePostActions } from "../hooks/usePostActions";

export function PostActions({ id }: { id: string }) {
  const actions = usePostActions(id);
  return <button onClick={() => actions.remove.mutate({ id })}>Delete</button>;
}

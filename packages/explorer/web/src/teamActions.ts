// Publish to the team and remove from it, shared by the saved-views menu and the Curation section. One request to the
// explorer's own server per click; the server decides who may publish or remove and its message comes back as is.
import { useCallback, useRef, useState } from "react";
import { api } from "./api.ts";
import { teamViewsStore } from "./teamViewsStore.ts";

export interface TeamResult {
  tone: "ok" | "error";
  text: string;
}

export interface TeamActions {
  /** The line to show after the last action (`aria-live`), or null. */
  result: TeamResult | null;
  busy: boolean;
  /** Publishes (`publish: true`) or removes the view or group. Never throws; a refusal becomes the result. */
  run: (kind: "view" | "group", id: string, publish: boolean) => Promise<void>;
  clear: () => void;
}

export const PUBLISHED_TEXT = "Published to team.";
export const REMOVED_TEXT = "Removed from team.";

export function useTeamActions(): TeamActions {
  const [result, setResult] = useState<TeamResult | null>(null);
  const [busy, setBusy] = useState(false);
  // One request at a time. A button that is busy is `aria-disabled`, not `disabled`, so it keeps focus; a click on it
  // lands here and is ignored.
  const running = useRef(false);
  const run = useCallback(async (kind: "view" | "group", id: string, publish: boolean) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await (publish ? api.publishTeam(kind, id) : api.unpublishTeam(kind, id));
      await teamViewsStore.reload();
      setResult({ tone: "ok", text: publish ? PUBLISHED_TEXT : REMOVED_TEXT });
    } catch (err) {
      // The item stays as it was: nothing was changed on the server, so there is nothing to undo here.
      setResult({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return { result, busy, run, clear: useCallback(() => setResult(null), []) };
}

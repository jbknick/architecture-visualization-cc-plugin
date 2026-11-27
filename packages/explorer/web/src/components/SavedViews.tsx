import { useState } from "react";
import { api } from "../api.ts";
import { uniqueId, viewFromRoute } from "../curation.ts";
import { useOverlay } from "../overlayStore.ts";
import { emptyRoute } from "../route.ts";
import { useStore } from "../store.tsx";
import { rememberView, useTeamViews } from "../teamViewsStore.ts";
import { NameDialog } from "./NameDialog.tsx";
import Dialog from "./smoothui/dialog/index.tsx";
import { TeamViewsMenu } from "./TeamViewsMenu.tsx";
import { Button } from "./ui/button.tsx";
import { NativeSelect } from "./ui/native-select.tsx";

const SAVE = "\u0000save";
const RESET = "\u0000reset";

/**
 * The saved-view switcher of the top bar: the saved views by name, then `Save view…` (the current picture under a
 * name) and `Reset curation…` (drops every label, hidden part, group and saved view after a confirmation). With a team
 * cache for the repo the select becomes a menu with a `Team` heading (`TeamViewsMenu`); without one it is this select.
 */
export function SavedViews() {
  const { state, view, navigate, writeOverlay } = useStore();
  const overlay = useOverlay();
  const { data: team, loadedAt } = useTeamViews();
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  if (!overlay) return null;

  const route = state.route;
  const onPick = (value: string) => {
    if (value === SAVE) setSaving(true);
    else if (value === RESET) {
      setResetError(null);
      setResetting(true);
    } else {
      const picked = overlay.views.find((v) => v.id === value);
      if (picked) navigate({ ...emptyRoute, view: picked.spec.view, saved: picked.id });
    }
  };
  /** A pick in the team menu: the views are the merged list (the team's and the person's own). */
  const onPickMerged = (id: string) => {
    const picked = team?.views.find((v) => v.id === id);
    if (!picked) return;
    rememberView(id);
    navigate({ ...emptyRoute, view: picked.spec.view, saved: picked.id });
  };
  const save = (name: string) => {
    const id = uniqueId(name, [...overlay.views.map((v) => v.id), ...(team?.views.map((v) => v.id) ?? [])]);
    if (id === null || view === null)
      return Promise.reject(new Error("A view name needs at least one letter or digit."));
    return writeOverlay(() =>
      api.putView(
        viewFromRoute(id, name, { view, level: route.level, focus: route.focus, filters: route.filters }),
      ),
    ).then(() => navigate({ saved: id }));
  };
  const reset = async () => {
    setResetError(null);
    try {
      await writeOverlay(() => api.resetOverlay());
      setResetting(false);
      if (route.saved) navigate({ saved: null });
    } catch (err) {
      setResetError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      {team ? (
        <TeamViewsMenu
          team={team}
          loadedAt={loadedAt}
          current={route.saved}
          onPick={onPickMerged}
          onSave={() => onPick(SAVE)}
          onReset={() => onPick(RESET)}
        />
      ) : (
        <NativeSelect
          size="sm"
          className="saved-views"
          aria-label="Saved view"
          value={route.saved && overlay.views.some((v) => v.id === route.saved) ? route.saved : ""}
          onChange={(e) => onPick(e.target.value)}
        >
          <option value="">Saved views</option>
          {overlay.views.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
          <option value={SAVE}>Save view…</option>
          <option value={RESET}>Reset curation…</option>
        </NativeSelect>
      )}
      <NameDialog
        open={saving}
        title="Save view"
        description="Saves the level, focus and filters of this picture. Names, hidden parts and groups apply to every view."
        confirm="Save"
        onClose={() => setSaving(false)}
        onSubmit={save}
      />
      <Dialog
        open={resetting}
        onOpenChange={(next) => {
          if (!next) setResetting(false);
        }}
        title="Reset curation"
        description="This removes every name, hidden part, group and saved view. It cannot be undone."
        showCloseButton={false}
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setResetting(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={() => void reset()}>
              Reset
            </Button>
          </>
        }
      >
        {resetError && (
          <p className="notice" role="alert">
            {resetError}
          </p>
        )}
      </Dialog>
    </>
  );
}

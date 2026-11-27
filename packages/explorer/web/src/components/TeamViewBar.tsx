import { LockIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { uniqueId } from "../curation.ts";
import { emptyRoute } from "../route.ts";
import { useStore } from "../store.tsx";
import { rememberView, useTeamViews } from "../teamViewsStore.ts";
import { ageWords, currentAge, STALE_AFTER_S } from "../views/teamModel.ts";
import { Button } from "./ui/button.tsx";

/**
 * The bar over the map while a team view is open. A team view is read-only: the bar names it, says so in text (with a
 * lock, never by colour alone) and offers `Save a personal copy` where an edit control would be. The copy is a view of
 * your own with a new id, and it opens at once. The name is text from a teammate and is rendered as text.
 */
export function TeamViewBar() {
  const { state, navigate, writeOverlay } = useStore();
  const { data: team, loadedAt } = useTeamViews();
  const [error, setError] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  // Only someone else's item is read-only: your own published view (`own`) opens as the view of yours it is.
  const picked = team?.views.find((v) => v.origin === "team" && !v.own && v.id === state.route.saved);

  // The map crossfades in when a team view opens (see `.center.team-open` in styles.css).
  const open = picked !== undefined;
  useEffect(() => {
    const main = bar.current?.closest("main");
    if (!open || !main) return;
    main.classList.add("team-open");
    return () => main.classList.remove("team-open");
  }, [open]);

  if (!team || !picked) return null;
  const age = currentAge(team.age_s, loadedAt, Date.now());
  const stale = age !== null && age > STALE_AFTER_S;

  const copy = async () => {
    setError(null);
    const name = `${picked.name} copy`.slice(0, 80);
    const id = uniqueId(
      name,
      team.views.map((v) => v.id),
    );
    if (id === null) return setError("A view name needs at least one letter or digit.");
    try {
      await writeOverlay(() => api.putView({ id, name, spec: picked.spec }));
      rememberView(id);
      navigate({ ...emptyRoute, view: picked.spec.view, saved: id });
      // The bar goes away with the team view: focus moves to the switcher, which now names the copy.
      document.querySelector<HTMLElement>("button.views-trigger")?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section ref={bar} className="team-view-bar" aria-label="Team view" data-testid="team-view-bar">
      <HugeiconsIcon icon={UserGroupIcon} size={16} aria-hidden="true" />
      <strong className="team-view-name">{picked.name}</strong>
      <span className="team-view-note" data-testid="team-view-note">
        <HugeiconsIcon icon={LockIcon} size={14} aria-hidden="true" />
        Team view: read-only
      </span>
      {age !== null && (
        <span className={`team-view-pulled${stale ? " views-stale" : ""}`}>pulled {ageWords(age)} ago</span>
      )}
      <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
        Save a personal copy
      </Button>
      {error && (
        <span className="notice" role="alert">
          {error}
        </span>
      )}
    </section>
  );
}

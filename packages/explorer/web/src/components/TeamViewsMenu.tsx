import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  EyeIcon,
  FloppyDiskIcon,
  MoreHorizontalIcon,
  Tick02Icon,
  UnfoldMoreIcon,
  Upload01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { TeamView, TeamViewsData } from "../api.ts";
import { useTeamActions } from "../teamActions.ts";
import { ageWords, currentAge, STALE_AFTER_S } from "../views/teamModel.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";

const ITEM = "[data-menu-item]";

interface Props {
  team: TeamViewsData;
  /** `Date.now()` when `team` was read, for the age on the Team heading. */
  loadedAt: number | null;
  /** The id of the open saved view. */
  current: string | null;
  onPick: (id: string) => void;
  onSave: () => void;
  onReset: () => void;
}

/**
 * The saved-view switcher when the repo has a team cache: the person's own views, then a `Team` heading with the team's
 * views, the default marked. Every name is rendered as text. The menu is a labeled `role="menu"`: arrow keys move,
 * Enter selects, Escape closes and returns focus to the button. A view's `…` item opens its action (Publish to team or
 * Remove from team); the result of the action is read out from an `aria-live` line under the list.
 */
export function TeamViewsMenu({ team, loadedAt, current, onPick, onSave, onReset }: Props) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState<string | null>(null);
  const actions = useTeamActions();
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const moreButtons = useRef(new Map<string, HTMLButtonElement>());
  const menuId = useId();
  const teamHeading = useId();
  const mineHeading = useId();

  // Your own published view stays under Your views, marked Published; its copy in the team's list (`own`) is not repeated.
  const mine = team.views.filter((v) => v.origin === "local");
  const theirs = team.views.filter((v) => v.origin === "team" && v.own !== true);
  const openView = theirs.find((v) => v.id === current) ?? mine.find((v) => v.id === current);
  const age = currentAge(team.age_s, loadedAt, Date.now());
  const stale = age !== null && age > STALE_AFTER_S;

  const close = (refocus: boolean) => {
    setOpen(false);
    setMore(null);
    if (refocus) trigger.current?.focus();
  };
  const toggle = () => {
    if (open) return close(false);
    actions.clear();
    setOpen(true);
  };

  // Focus the open view's row when the menu opens (else the first item), so the keys work at once.
  useEffect(() => {
    if (!open) return;
    const root = menu.current;
    (
      root?.querySelector<HTMLElement>('[aria-checked="true"]') ?? root?.querySelector<HTMLElement>(ITEM)
    )?.focus();
  }, [open]);

  // When an action answers, focus must still be inside the menu (the row it came from may be gone): the arrow keys and
  // Escape then keep working.
  const answered = actions.result;
  useEffect(() => {
    const root = menu.current;
    if (!answered || !root || root.contains(document.activeElement)) return;
    root.querySelector<HTMLElement>(ITEM)?.focus();
  }, [answered]);

  // A click outside the menu closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !wrap.current?.contains(e.target)) {
        setOpen(false);
        setMore(null);
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? items.length - 1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") close(false);
  };

  const pick = (id: string) => {
    close(true);
    onPick(id);
  };

  const row = (v: TeamView, fromTeam: boolean) => {
    const key = `${fromTeam ? "team" : "local"}:${v.id}`;
    const isPublished = !fromTeam && v.published === true;
    // Your view carries the check itself when it is the open one, unless a teammate's view with its id is in the way.
    const checked = v.id === current && (fromTeam || isPublished || v.shadowed !== true);
    const expanded = more === key;
    // Your own view offers Publish to team, or Remove from team once the team holds one with its id; a team view only
    // offers Remove from team (the server says who may).
    const removing = fromTeam || isPublished;
    return (
      <div key={key} role="none" className="views-block">
        <div role="none" className="views-row">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={checked}
            data-menu-item=""
            tabIndex={-1}
            className="views-item"
            data-testid={fromTeam ? "team-view-item" : "own-view-item"}
            onClick={() => pick(v.id)}
          >
            <HugeiconsIcon icon={fromTeam ? UserGroupIcon : EyeIcon} size={16} aria-hidden="true" />
            <span className="views-name">{v.name}</span>
            {fromTeam && v.id === team.default_view && (
              <>
                <Badge
                  variant="secondary"
                  className="views-pop"
                  data-testid="default-badge"
                  aria-hidden="true"
                >
                  Default
                </Badge>
                <span className="sr-only">Team default</span>
              </>
            )}
            {isPublished && (
              <span className="views-pop views-published" data-testid="published-marker">
                <HugeiconsIcon icon={UserGroupIcon} size={14} aria-hidden="true" />
                Published
              </span>
            )}
            {checked && (
              <HugeiconsIcon icon={Tick02Icon} size={16} aria-hidden="true" className="views-check" />
            )}
          </button>
          <button
            ref={(el) => {
              if (el) moreButtons.current.set(key, el);
              else moreButtons.current.delete(key);
            }}
            type="button"
            role="menuitem"
            data-menu-item=""
            tabIndex={-1}
            className="views-more"
            aria-label={`More actions for ${v.name}`}
            aria-expanded={expanded}
            onClick={() => setMore(expanded ? null : key)}
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} size={16} aria-hidden="true" />
          </button>
        </div>
        {expanded && (
          <button
            type="button"
            role="menuitem"
            data-menu-item=""
            tabIndex={-1}
            className="views-item views-action"
            aria-disabled={actions.busy}
            onClick={() => {
              // Focus goes back to the row's `…` before the action item unmounts, so the keys keep working.
              moreButtons.current.get(key)?.focus();
              void actions.run("view", v.id, !removing);
              setMore(null);
            }}
          >
            <HugeiconsIcon icon={removing ? Delete02Icon : Upload01Icon} size={16} aria-hidden="true" />
            <span className="views-name">{removing ? "Remove from team" : "Publish to team"}</span>
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="saved-views-wrap" ref={wrap}>
      <Button
        ref={trigger}
        type="button"
        variant="outline"
        size="sm"
        className="saved-views views-trigger"
        // The name starts with what the button shows (the open view), so the visible label is in the accessible one.
        aria-label={openView ? `Saved view: ${openView.name}` : "Saved view"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            toggle();
          }
        }}
      >
        {openView?.origin === "team" && <HugeiconsIcon icon={UserGroupIcon} size={14} aria-hidden="true" />}
        <span className="views-name">{openView?.name ?? "Saved views"}</span>
        <HugeiconsIcon icon={UnfoldMoreIcon} size={14} aria-hidden="true" className="views-chevron" />
      </Button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="Saved views"
          className="views-menu"
          data-testid="views-menu"
          onKeyDown={onMenuKey}
        >
          {mine.length > 0 && (
            <fieldset aria-labelledby={mineHeading} className="views-group">
              <div id={mineHeading} className="views-heading">
                Your views
              </div>
              {mine.map((v) => row(v, false))}
            </fieldset>
          )}
          <fieldset aria-labelledby={teamHeading} className="views-group" data-testid="team-group">
            <div className="views-heading">
              <span id={teamHeading}>Team</span>
              {age !== null && (
                <span className={`views-pulled${stale ? " views-stale" : ""}`} data-testid="views-pulled">
                  pulled {ageWords(age)} ago
                </span>
              )}
            </div>
            {theirs.length === 0 && <p className="views-empty">The team has no saved views yet.</p>}
            {theirs.map((v) => row(v, true))}
          </fieldset>
          <div role="none" className="views-rule" />
          <button
            type="button"
            role="menuitem"
            data-menu-item=""
            tabIndex={-1}
            className="views-item"
            onClick={() => {
              close(false);
              onSave();
            }}
          >
            <HugeiconsIcon icon={FloppyDiskIcon} size={16} aria-hidden="true" />
            <span className="views-name">Save view…</span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-menu-item=""
            tabIndex={-1}
            className="views-item"
            onClick={() => {
              close(false);
              onReset();
            }}
          >
            <HugeiconsIcon icon={Delete02Icon} size={16} aria-hidden="true" />
            <span className="views-name">Reset curation…</span>
          </button>
          {/* The live region is always there (empty, not hidden), so a reader is watching when the result arrives. */}
          <div className="views-result" aria-live="polite" data-testid="views-result">
            {actions.result && (
              <p
                className="views-result-line"
                data-tone={actions.result.tone}
                data-testid="views-result-line"
              >
                <HugeiconsIcon
                  icon={actions.result.tone === "ok" ? CheckmarkCircle02Icon : Alert02Icon}
                  size={16}
                  aria-hidden="true"
                />
                <span>{actions.result.text}</span>
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

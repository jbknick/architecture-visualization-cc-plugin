// The Team layer's side panel. Top to bottom: the heading, how old the data is, the people filter, then one row per
// open change set; the picked row opens to show its blast radius, the map legend and the code it changes.
// Titles and owner names come from outside the machine and are rendered as React text only.
import { Cancel01Icon, RefreshIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { TeamChangeSet, TeamLayerData } from "../api.ts";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { useStore } from "../store.tsx";
import { initialStyle } from "./personColours.ts";
import { ReviewLegend } from "./ReviewLegend.tsx";
import { Icon, initialOf, Swatch } from "./TeamBits.tsx";
import { TeamLayerRings } from "./TeamLayerRings.tsx";
import { TEAM_TOGGLE_ID } from "./TeamLayerToggle.tsx";
import {
  ageWords,
  changedRows,
  countFor,
  countText,
  currentAge,
  STALE_AFTER_S,
  STATE_WORDS,
  tierCounts,
  titleOf,
  visibleSets,
} from "./teamModel.ts";
import { teamStore, useTeam } from "./teamStore.ts";
import "./review.css";
import "./team.css";

const EASE_OUT = [0.23, 1, 0.32, 1] as const;
/** The row detail opens from, and closes to, no height. */
const SHUT = { opacity: 0, height: 0 };
const AJAR = { opacity: 1, height: "auto" };
const SLID_OUT = { opacity: 0, x: 16 };
const SLID_IN = { opacity: 1, x: 0 };
const FIRST_PAINT = false;
const USER_MOTION = "user" as const;
/** How often the age of the data is worked out again. */
const AGE_TICK_MS = 60_000;

/** A person's initial on their own color, the color their map markers use. */
function PersonChip({ name, people }: { name: string; people: readonly string[] }) {
  return (
    <span className="team-chip" style={initialStyle(people, name)} aria-hidden="true">
      {initialOf(name)}
    </span>
  );
}

/** The clock, read again every `everyMs` and whenever the data is read again. */
function useClock(everyMs: number, readAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new read of the data restarts the clock
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs, readAt]);
  return now;
}

/** How old the data is: the age it had when it was read plus the time since, so it ages without a Refresh. */
function Pulled({ ageWhenRead }: { ageWhenRead: number | null }) {
  const { state } = useStore();
  const team = useTeam();
  const age = currentAge(ageWhenRead, team.loadedAt, useClock(AGE_TICK_MS, team.loadedAt));
  const stale = age !== null && age > STALE_AFTER_S;
  return (
    <div className={stale ? "team-pulled is-stale" : "team-pulled"} data-testid="team-freshness">
      <p className="team-pulled-line">
        {age === null ? (
          "Team data has no pull time"
        ) : (
          <>
            Team data pulled <strong>{ageWords(age)}</strong> ago
          </>
        )}
      </p>
      <Button
        variant="outline"
        size="xs"
        title="Read the local team cache again"
        disabled={team.refreshing}
        onClick={() => void teamStore.refresh(state.route.filters.scenario)}
      >
        <Icon icon={RefreshIcon} size={12} />
        Refresh
      </Button>
      <p className="team-pulled-note">
        Refresh re-reads the local cache. <code>gantry team status --pull</code> fetches new data.
      </p>
    </div>
  );
}

/** The four counts under a change set's title. */
function TierLine({ set }: { set: TeamChangeSet }) {
  const c = tierCounts(set);
  const parts = [
    { tone: "modified", tip: "Changed nodes", text: `${countText(c.changed, c.changedFloor)} changed` },
    { tone: "affected", tip: "Directly affected", text: `${countText(c.direct, c.floor.direct)} direct` },
    {
      tone: "potential",
      tip: "Potentially affected",
      text: `${countText(c.potential, c.floor.potential)} potential`,
    },
    { tone: "reach", tip: "Reachable", text: `${countText(c.reachable, c.floor.reachable)} reachable` },
  ] as const;
  return (
    <span className="team-tiers">
      {parts.map((p) => (
        <span key={p.tone} title={p.tip}>
          <Swatch tone={p.tone} />
          {p.text}
        </span>
      ))}
    </span>
  );
}

/** What the picked change set shows below its row: radius bands, the map legend and the changed code. */
function Detail({ set }: { set: TeamChangeSet }) {
  const { selectNode } = useStore();
  const rows = changedRows(set);
  const c = tierCounts(set);
  return (
    <>
      <TeamLayerRings set={set} />
      <ReviewLegend mode="2d" reachable lines="solid" kinds={["modified"]} className="team-legend" />
      <h4 className="team-detail-title">
        Changed nodes <span className="count">{countText(c.changed, c.changedFloor)}</span>
      </h4>
      <ul className="team-changed" data-testid="team-nodes">
        {rows.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              className="team-changed-btn"
              aria-label={`${n.name}, in ${n.path}. Opens the inspector`}
              onClick={() => selectNode(n.id)}
            >
              <Swatch tone="modified" />
              <span className="team-changed-text">
                <span className="team-changed-name">{n.name}</span>
                <span className="team-changed-path">
                  {n.path} · {n.isFile ? "file" : "modified"}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {c.changedFloor && (
        <p className="team-pulled-note">
          Showing the first {c.changed} changed nodes; more are in the team data.
        </p>
      )}
    </>
  );
}

function People({ data, picked }: { data: TeamLayerData; picked: readonly string[] }) {
  const toggle = (name: string, on: boolean) =>
    teamStore.setPeople(on ? [...picked, name] : picked.filter((p) => p !== name));
  return (
    <fieldset className="team-people">
      <legend>People</legend>
      {data.people.map((name) => (
        <label key={name} className="team-person">
          <Checkbox
            checked={picked.includes(name)}
            onCheckedChange={(on) => toggle(name, on)}
            aria-label={name}
          />
          <PersonChip name={name} people={data.people} />
          <span className="team-person-name">{name}</span>
          <span className="team-person-count">{countFor(data, name)}</span>
        </label>
      ))}
      {picked.length > 0 && (
        <button type="button" className="link-btn" onClick={() => teamStore.setPeople([])}>
          Show everyone
        </button>
      )}
    </fieldset>
  );
}

export function TeamLayerPanel() {
  const team = useTeam();
  const calm = useReducedMotion() ?? false;
  const panel = useRef<HTMLElement>(null);
  // Focus moves into the panel when the layer turns on.
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, []);
  const data = team.data;
  if (!data) return null;
  const sets = visibleSets(data, team.people);
  const picked = sets.find((c) => c.id === team.pickedId) ?? null;
  const spring = { duration: calm ? 0 : 0.18, ease: EASE_OUT };

  return (
    <MotionConfig reducedMotion={USER_MOTION}>
      <motion.aside
        ref={panel}
        tabIndex={-1}
        className="team-panel"
        aria-label="Team layer panel"
        data-testid="team-panel"
        initial={calm ? { opacity: 0 } : SLID_OUT}
        animate={SLID_IN}
        exit={calm ? { opacity: 0 } : SLID_OUT}
        transition={{ duration: calm ? 0 : 0.2, ease: EASE_OUT }}
      >
        <header className="team-panel-head">
          <h2 className="panel-title team-panel-title">
            <Icon icon={UserGroupIcon} size={14} />
            Team
          </h2>
          <Badge variant="secondary">{`${sets.length} open`}</Badge>
          <Button
            variant="ghost"
            size="icon-sm"
            className="team-panel-close"
            aria-label="Close the Team layer"
            onClick={() => {
              teamStore.setOn(false);
              // The panel (and this button) go away: focus goes back to the switch that opened it.
              document.getElementById(TEAM_TOGGLE_ID)?.focus();
            }}
          >
            <Icon icon={Cancel01Icon} size={16} />
          </Button>
        </header>

        <Pulled ageWhenRead={data.age_s} />

        {data.people.length > 0 && <People data={data} picked={team.people} />}

        <section className="team-open" aria-label="Open changes">
          <h3>
            Open changes <span className="count">{String(sets.length)}</span>
          </h3>
          {sets.length === 0 && <p className="muted">No open pull requests in the team data</p>}
          <ul className="team-entries">
            <AnimatePresence initial={FIRST_PAINT}>
              {sets.map((c) => {
                const isPicked = team.pickedId === c.id;
                return (
                  <motion.li
                    key={c.id}
                    layout={!calm}
                    initial={SHUT}
                    animate={AJAR}
                    exit={SHUT}
                    transition={spring}
                    data-testid="team-entry"
                    data-owner={c.owner}
                  >
                    <button
                      type="button"
                      className="team-entry-btn"
                      aria-pressed={isPicked}
                      onClick={() => teamStore.pick(isPicked ? null : c.id)}
                    >
                      {isPicked && (
                        <motion.span
                          layoutId="team-entry-mark"
                          className="team-entry-mark"
                          transition={{ duration: calm ? 0 : 0.2, ease: EASE_OUT }}
                        />
                      )}
                      <span className="team-entry-title">{titleOf(c)}</span>
                      <span className="team-entry-by">
                        <PersonChip name={c.owner} people={data.people} />
                        {c.owner}
                        {c.pr !== undefined ? ` · #${c.pr}` : ""} · {STATE_WORDS[c.state]}
                      </span>
                      {!picked && <TierLine set={c} />}
                    </button>
                    <AnimatePresence initial={FIRST_PAINT}>
                      {isPicked && (
                        <motion.div
                          className="team-detail"
                          initial={SHUT}
                          animate={AJAR}
                          exit={SHUT}
                          transition={{ duration: calm ? 0 : 0.22, ease: EASE_OUT }}
                        >
                          <Detail set={c} />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        </section>
      </motion.aside>
    </MotionConfig>
  );
}

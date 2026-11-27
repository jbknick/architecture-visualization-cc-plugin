import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { useEffect } from "react";
import { useRefresh } from "../refresh.ts";
import { useStore } from "../store.tsx";
import { Icon } from "./TeamBits.tsx";
import { teamStore, useTeam } from "./teamStore.ts";
import "./team.css";

/** The Team toggle's id: closing the panel hands focus back to it. */
export const TEAM_TOGGLE_ID = "team-layer-toggle";

/**
 * The `Team` switch in the project map's toolbar. It asks the explorer's own server for the local team cache when the
 * map appears and again after every Refresh of the top bar (a pull made since then shows up), and renders nothing at
 * all while there is no usable cache, so a repo without a team looks exactly as before.
 */
export function TeamLayerToggle() {
  const team = useTeam();
  const { state } = useStore();
  const { generation } = useRefresh();
  const scenario = state.route.filters.scenario;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` only triggers a new read
  useEffect(() => {
    void teamStore.load(scenario);
  }, [scenario, generation]);
  const { on } = team;
  if (!team.data?.available) return null;
  return (
    <>
      <button
        type="button"
        id={TEAM_TOGGLE_ID}
        className="gc-btn team-toggle"
        aria-pressed={on}
        title="Show every open pull request of the team on the map"
        data-testid="team-toggle"
        onClick={() => teamStore.setOn(!on)}
      >
        <Icon icon={UserGroupIcon} size={14} />
        Team
      </button>
      <span className="team-toggle-gap" aria-hidden="true" />
    </>
  );
}

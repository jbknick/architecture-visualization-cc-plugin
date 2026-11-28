// "How to read it" for the settlements: every encoding the scene uses.
import { TIER_PATH } from "./icons.ts";
import { TIER_FLOOR, TIERS } from "./tiers.ts";

function Icon({ d }: { d: string }) {
  return (
    <svg className="s3-legend-icon" viewBox="0 0 24 14" aria-hidden="true">
      <path d={d} fill="currentColor" />
    </svg>
  );
}

export function SettlementsHowTo() {
  return (
    <ul id="map3d-howto-body" className="s3-howto">
      <li>
        <span className="s3-tiers" aria-hidden="true">
          {TIERS.map((t) => (
            <Icon key={t} d={TIER_PATH[t]} />
          ))}
        </span>
        <span>
          <strong>Settlement</strong> = one workspace. By functions, ranked within this repo:{" "}
          <strong>village</strong> (cottages, fields, a windmill), <strong>town</strong> (houses, a church),{" "}
          <strong>city</strong> (blocks, cranes), <strong>metropolis</strong> (a tower core, suburbs). Under{" "}
          {TIER_FLOOR.town} functions is always a village. Kerb and roof color = workspace, as in the list
          below.
        </span>
      </li>
      <li>
        <svg className="s3-legend-icon" viewBox="0 0 24 14" aria-hidden="true">
          <path d="M3 14V8h5v6zM10 14V3h5v11zM17 14V6h4v8z" fill="currentColor" />
        </svg>
        <span>
          <strong>Building</strong> = one file: taller = more functions, wider = more lines. Folders are
          districts (wedges of the settlement, divided by streets); the biggest files stand nearest the
          middle.
        </span>
      </li>
      <li>
        <svg className="s3-legend-icon" viewBox="0 0 24 14" aria-hidden="true">
          <path
            d="M2 14V9h6v5zM2 9a3 3 0 0 1 6 0zM11 14V5h3v9zM10 5l2.5-3L15 5zM17 14V8h5v6zM16.5 8h6l-1 2h-4z"
            fill="currentColor"
          />
        </svg>
        <span>
          <strong>Shapes</strong>: dome = test file, water tower = config, kiosk = index or entry file,
          station hall or columned porch = route, page or handler, shop awning = component.
        </span>
      </li>
      <li>
        <svg className="s3-legend-icon" viewBox="0 0 24 14" aria-hidden="true">
          <rect x="0" y="1" width="24" height="2" rx="1" fill="currentColor" opacity="0.45" />
          <rect x="0" y="5.5" width="24" height="3" rx="1" fill="currentColor" opacity="0.7" />
          <rect x="0" y="10" width="24" height="4" rx="1" fill="currentColor" />
        </svg>
        <span>
          <strong>Road A – B</strong> = imports between two workspaces: a dirt <strong>lane</strong> for a
          few, a <strong>road</strong>, a dual-carriageway <strong>highway</strong> for the heaviest. Vehicles
          and the yellow arrows go <strong>from the importer to the imported</strong> workspace; more imports,
          more traffic. The label says <em>A → B N</em>: A imports from B N times.
        </span>
      </li>
      <li>
        <svg className="s3-legend-icon" viewBox="0 0 24 14" aria-hidden="true">
          <path
            d="M4 14l1.5-9h2L9 14zM6.5 4.5L3 1l.8-.8 2.7 2.7L9.2.2l.8.8-3.5 3.5zM14 14V1h1v13zM15 1h8v1h-8z"
            fill="currentColor"
          />
        </svg>
        <span>
          <strong>Not files</strong>: windmills, churches, cranes, trees, fields, people, smoke and blinking
          tower lights only show the tier and keep the place alive.
        </span>
      </li>
    </ul>
  );
}

import { useEffect, useRef, useState } from "react";

/** The key lines of the project map: what a box, a line and a number mean (and what the filters hid). */
export function keyLines(level: string | null, hideTests: boolean, ranked = false): string[] {
  const lines = [
    "Box = workspace (area = functions) · Line colour = importing workspace · dot → arrowhead: A imports from B",
  ];
  const second = ["Number = files importing · thicker = more"];
  // Folders, Files and Functions levels (and a drilled-in view) draw tiles inside the boxes.
  if (level !== "workspaces") second.push("Tiles = folders / files (area = functions)");
  if (hideTests) second.push("Tests hidden");
  lines.push(second.join(" · "));
  if (ranked) lines.push("Numbers = largest files, listed on the left");
  return lines;
}

/**
 * A compact, collapsible key at the bottom-left of the canvas: two lines of text, or just "Key ▸". It folds itself
 * away while the camera is zoomed in past the fit, so it never covers tile labels (the user can open it again).
 */
export function MapKey({
  level,
  hideTests,
  ranked = false,
  zoomed = false,
  onToggle,
}: {
  level: string | null;
  hideTests: boolean;
  /** Files level with numbered markers on the tiles: the key says what they are. */
  ranked?: boolean;
  zoomed?: boolean;
  /** Called after the key opened or closed (the canvas keeps its pills clear of it). */
  onToggle?: () => void;
}) {
  const [open, setOpen] = useState(!zoomed);
  const wasZoomed = useRef(zoomed);
  useEffect(() => {
    if (zoomed && !wasZoomed.current) setOpen(false);
    wasZoomed.current = zoomed;
  }, [zoomed]);
  // The canvas redraws after every change of the key's size.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `open` is the trigger
  useEffect(() => onToggle?.(), [open, onToggle]);
  const lines = keyLines(level, hideTests, ranked);
  return (
    <div className="gc-key" data-testid="map-key" data-open={open}>
      <button
        type="button"
        className="gc-key-toggle"
        aria-expanded={open}
        title={open ? "Hide the key" : "Show the key"}
        onClick={() => setOpen((v) => !v)}
      >
        Key {open ? "▾" : "▸"}
      </button>
      {open && (
        <div className="gc-key-body">
          {lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

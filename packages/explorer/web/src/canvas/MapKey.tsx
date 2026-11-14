import { useState } from "react";

/** The key lines of the project map: what a box, an arrow and a number mean (and what the filters hid). */
export function keyLines(level: string | null, hideTests: boolean): string[] {
  const lines = [
    "Box = workspace (area = functions) · A → B = A imports from B · number = files importing · thicker = more",
  ];
  const second: string[] = [];
  // Folders, Files and Functions levels (and a drilled-in view) draw tiles inside the boxes.
  if (level !== "workspaces") second.push("Tiles = folders / files (area = functions)");
  if (hideTests) second.push("Tests hidden");
  if (second.length > 0) lines.push(second.join(" · "));
  return lines;
}

/** A compact, collapsible key at the bottom-left of the canvas: at most two lines of text. */
export function MapKey({ level, hideTests }: { level: string | null; hideTests: boolean }) {
  const [open, setOpen] = useState(true);
  const lines = keyLines(level, hideTests);
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

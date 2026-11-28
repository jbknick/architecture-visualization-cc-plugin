import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "../components/ui/button.tsx";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Center-of-screen explanation shown by the ego view until a function is chosen. */
export function EgoPrompt() {
  const focusSearch = () => {
    const box = document.querySelector<HTMLInputElement>('input[aria-label="Search symbols"]');
    box?.focus();
    box?.select();
  };
  return (
    <div className="empty-state" data-testid="ego-empty">
      <h2>Pick a function to see its callers and callees</h2>
      <p>
        This view shows who uses one function and what it uses in turn. Press{" "}
        <kbd>{isMac ? "⌘K" : "Ctrl K"}</kbd>, type a function name, then press Enter.
      </p>
      <Button variant="outline" onClick={focusSearch}>
        <HugeiconsIcon icon={Search01Icon} size={14} aria-hidden="true" />
        Search for a function
      </Button>
      <p className="muted">
        You can also open any node in the inspector and choose &ldquo;Show callers &amp; callees&rdquo;.
      </p>
    </div>
  );
}

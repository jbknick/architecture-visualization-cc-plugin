const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Centre-of-screen explanation shown by the ego view until a function is chosen. */
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
      <button type="button" className="btn" onClick={focusSearch}>
        Search for a function
      </button>
      <p className="muted">
        You can also open any node in the inspector and choose &ldquo;Show callers &amp; callees&rdquo;.
      </p>
    </div>
  );
}

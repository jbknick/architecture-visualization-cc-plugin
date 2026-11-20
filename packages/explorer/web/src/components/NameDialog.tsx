import { useEffect, useState } from "react";
import Dialog from "./smoothui/dialog/index.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";

interface NameDialogProps {
  open: boolean;
  /** The dialog's accessible name (`Save view`, `New group`, `Rename group`). */
  title: string;
  description?: string;
  /** Text of the confirm button. */
  confirm: string;
  initial?: string;
  /** Saves the name; a rejection's message is shown in the dialog and keeps it open. */
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}

/** A dialog with one text field `Name` (at most 80 characters, the schema's limit) and a confirm button. */
export function NameDialog({
  open,
  title,
  description,
  confirm,
  initial = "",
  onSubmit,
  onClose,
}: NameDialogProps) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(initial);
      setError(null);
    }
  }, [open, initial]);

  const trimmed = name.trim();
  const submit = async () => {
    if (trimmed === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      description={description}
      showCloseButton={false}
      className="name-dialog"
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="name-dialog-form" disabled={trimmed === "" || busy}>
            {confirm}
          </Button>
        </>
      }
    >
      <form
        id="name-dialog-form"
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          aria-label="Name"
          value={name}
          maxLength={80}
          autoFocus
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
        />
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

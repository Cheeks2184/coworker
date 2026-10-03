import { useEffect, useId, useState, type ReactNode } from "react";
import { readableError } from "../lib/errors";
import { ModalPortal } from "./ModalPortal";

/** Confirms a destructive action, staying open with the error if the action fails. */
export function ConfirmDialog({
  eyebrow,
  title,
  children,
  confirmLabel,
  busyLabel,
  onCancel,
  onConfirm,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (confirmError) {
      setError(readableError(confirmError));
      setBusy(false);
    }
  }

  return (
    <ModalPortal>
      <div className="modal-backdrop" onMouseDown={busy ? undefined : onCancel} role="presentation">
        <section
          aria-labelledby={titleId}
          aria-modal="true"
          className="modal-card archive-confirm-modal"
          onMouseDown={(event) => event.stopPropagation()}
          role="alertdialog"
        >
          <span className="eyebrow">{eyebrow}</span>
          <h2 id={titleId}>{title}</h2>
          {children}
          {error ? <div className="inline-error">{error}</div> : null}
          <div className="modal-actions">
            <button autoFocus className="secondary-button" disabled={busy} onClick={onCancel} type="button">
              Cancel
            </button>
            <button
              className="secondary-button destructive-button"
              disabled={busy}
              onClick={() => void confirm()}
              type="button"
            >
              {busy ? busyLabel : confirmLabel}
            </button>
          </div>
        </section>
      </div>
    </ModalPortal>
  );
}

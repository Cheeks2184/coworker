import { useEffect, useState, type ReactNode } from "react";
import type { Coworker } from "@shared/contracts";
import { Icon } from "./Icon";
import { ModalPortal } from "./ModalPortal";
import { usePinnedCoworkers } from "../lib/pinned-coworkers";

export interface MenuPosition {
  x: number;
  y: number;
}

/** Keeps a menu opened at the pointer (or a button) inside the window. */
export function menuPositionFor(point: { clientX: number; clientY: number }): MenuPosition {
  return {
    x: Math.min(point.clientX, window.innerWidth - 230),
    y: Math.min(point.clientY, window.innerHeight - 150),
  };
}

/** The ⋯ button that opens a coworker's actions without needing a right-click. */
export function CoworkerMoreButton({
  coworker,
  className = "",
  onOpen,
}: {
  coworker: Pick<Coworker, "name">;
  className?: string;
  onOpen: (position: MenuPosition) => void;
}) {
  return (
    <span
      aria-label={`More actions for ${coworker.name}`}
      className={`coworker-more-button ${className}`.trim()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        onOpen(menuPositionFor({ clientX: rect.left, clientY: rect.bottom + 4 }));
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        onOpen(menuPositionFor({ clientX: rect.left, clientY: rect.bottom + 4 }));
      }}
      onPointerDown={(event) => event.stopPropagation()}
      role="button"
      tabIndex={0}
      title="More actions"
    >
      <Icon name="more" />
    </span>
  );
}

/** Confirms changing who the primary coworker is, spelling out what moves with the role. */
export function PrimaryChangeDialog({
  target,
  currentPrimary,
  makePrimary,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  target: Coworker;
  currentPrimary: Coworker | null;
  makePrimary: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const replacing =
    makePrimary && currentPrimary && currentPrimary.id !== target.id ? currentPrimary : null;
  return (
    <ModalPortal>
      <div className="modal-backdrop" onMouseDown={onCancel} role="presentation">
        <section
          aria-labelledby="primary-confirm-title"
          aria-modal="true"
          className="modal-card archive-confirm-modal"
          onMouseDown={(event) => event.stopPropagation()}
          role="dialog"
        >
          <span className="eyebrow">Primary coworker</span>
          <h2 id="primary-confirm-title">
            {makePrimary
              ? `Make ${target.name} your primary coworker?`
              : `Remove ${target.name} as primary?`}
          </h2>
          {makePrimary ? (
            <ul className="primary-confirm-list">
              <li>
                {target.name} becomes your main point of contact and can hand work to other
                coworkers and report back.
              </li>
              <li>
                {target.name} gets a daily Team digest at 9:00, which you can change on the
                Schedules page.
              </li>
              {replacing ? (
                <li>
                  {replacing.name} will no longer be primary, and their Team digest will be paused.
                </li>
              ) : null}
              <li>The coworkers involved restart. Queued work is kept.</li>
            </ul>
          ) : (
            <p>
              You won’t have a primary coworker. {target.name}’s Team digest will be paused. You
              can make any coworker primary again later.
            </p>
          )}
          {error ? <div className="inline-error">{error}</div> : null}
          <div className="modal-actions">
            <button className="secondary-button" disabled={busy} onClick={onCancel} type="button">
              Cancel
            </button>
            <button className="primary-button" disabled={busy} onClick={onConfirm} type="button">
              {busy ? "Saving…" : makePrimary ? `Make ${target.name} primary` : "Remove as primary"}
            </button>
          </div>
        </section>
      </div>
    </ModalPortal>
  );
}

/**
 * The per-coworker actions shared by the sidebar and the Coworkers page:
 * pin/unpin, make/remove primary (with confirmation), and optional extras.
 */
export function useCoworkerActions({
  coworkers,
  onChanged,
  onOpenSettings,
}: {
  coworkers: Coworker[];
  onChanged: () => Promise<void>;
  onOpenSettings?: (coworker: Coworker) => void;
}): {
  pinnedIds: string[];
  openMenu: (coworker: Coworker, position: MenuPosition) => void;
  element: ReactNode;
} {
  const { pinnedIds, togglePin } = usePinnedCoworkers();
  const [menu, setMenu] = useState<{ coworker: Coworker; position: MenuPosition } | null>(null);
  const [change, setChange] = useState<{ coworker: Coworker; makePrimary: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menu]);

  // Always act on the latest copy (e.g. after another window changed the primary).
  const fresh = (coworker: Coworker) =>
    coworkers.find((candidate) => candidate.id === coworker.id) ?? coworker;

  const element = (
    <>
      {menu ? (
        <div
          className="coworker-context-menu"
          onPointerDown={(event) => event.stopPropagation()}
          role="menu"
          style={{ left: menu.position.x, top: menu.position.y }}
        >
          {onOpenSettings ? (
            <button
              onClick={() => {
                onOpenSettings(menu.coworker);
                setMenu(null);
              }}
              role="menuitem"
              type="button"
            >
              <Icon name="settings" />
              Open {menu.coworker.name} settings
            </button>
          ) : null}
          <button
            disabled={fresh(menu.coworker).isPrimary}
            onClick={() => {
              togglePin(menu.coworker.id);
              setMenu(null);
            }}
            role="menuitem"
            title={
              fresh(menu.coworker).isPrimary ? "The primary coworker is always pinned on top" : undefined
            }
            type="button"
          >
            <Icon name="pin" />
            {fresh(menu.coworker).isPrimary
              ? "Pinned as primary"
              : pinnedIds.includes(menu.coworker.id)
                ? "Unpin"
                : "Pin to top"}
          </button>
          <button
            onClick={() => {
              const target = fresh(menu.coworker);
              setError(null);
              setChange({ coworker: target, makePrimary: !target.isPrimary });
              setMenu(null);
            }}
            role="menuitem"
            type="button"
          >
            <Icon name="spark" />
            {fresh(menu.coworker).isPrimary ? "Remove as primary" : "Make primary"}
          </button>
        </div>
      ) : null}
      {change ? (
        <PrimaryChangeDialog
          busy={busy}
          currentPrimary={coworkers.find((item) => item.isPrimary) ?? null}
          error={error}
          makePrimary={change.makePrimary}
          onCancel={() => {
            if (!busy) setChange(null);
          }}
          onConfirm={async () => {
            setBusy(true);
            setError(null);
            try {
              await window.coworker.coworkers.update(change.coworker.id, {
                isPrimary: change.makePrimary,
              });
              await onChanged();
              setChange(null);
            } catch (changeError) {
              setError(changeError instanceof Error ? changeError.message : String(changeError));
            } finally {
              setBusy(false);
            }
          }}
          target={change.coworker}
        />
      ) : null}
    </>
  );

  return {
    pinnedIds,
    openMenu: (coworker, position) => setMenu({ coworker, position }),
    element,
  };
}

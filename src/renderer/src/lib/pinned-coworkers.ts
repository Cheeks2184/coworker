import { useCallback, useEffect, useState } from "react";
import type { Coworker } from "@shared/contracts";

// Pinning is a per-profile view preference, like the other sidebar settings,
// so it lives in local storage rather than the database.
const storageKey = "pinned-coworkers";
const changeEvent = "pinned-coworkers-changed";

export function readPinnedCoworkerIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writePinnedCoworkerIds(ids: string[]): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(ids));
  } catch {
    // Storage can be unavailable; pinning then lasts only for this session.
  }
  window.dispatchEvent(new CustomEvent(changeEvent, { detail: ids }));
}

/**
 * The primary coworker is always pinned, on top; then manual pins in the order
 * they were pinned; then everyone else in their existing order.
 */
export function splitPinnedCoworkers<T extends Pick<Coworker, "id" | "isPrimary">>(
  coworkers: T[],
  pinnedIds: string[],
): { pinned: T[]; others: T[] } {
  const byId = new Map(coworkers.map((coworker) => [coworker.id, coworker]));
  const primary = coworkers.filter((coworker) => coworker.isPrimary);
  const pinned = [
    ...primary,
    ...pinnedIds.flatMap((id) => {
      const coworker = byId.get(id);
      return coworker && !coworker.isPrimary ? [coworker] : [];
    }),
  ];
  const pinnedSet = new Set(pinned.map((coworker) => coworker.id));
  return { pinned, others: coworkers.filter((coworker) => !pinnedSet.has(coworker.id)) };
}

export function togglePinnedId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id];
}

export function usePinnedCoworkers() {
  const [pinnedIds, setPinnedIds] = useState<string[]>(readPinnedCoworkerIds);
  useEffect(() => {
    const sync = () => setPinnedIds(readPinnedCoworkerIds());
    window.addEventListener(changeEvent, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(changeEvent, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const togglePin = useCallback((id: string) => {
    const next = togglePinnedId(readPinnedCoworkerIds(), id);
    setPinnedIds(next);
    writePinnedCoworkerIds(next);
  }, []);
  return { pinnedIds, togglePin };
}

export type PinnedLayout = "row" | "list";
const layoutKey = "pinned-coworkers-layout";

/** How manually pinned coworkers are shown: a row of avatars (default) or the normal list. */
export function usePinnedLayout() {
  const [layout, setLayout] = useState<PinnedLayout>(() => {
    try {
      return window.localStorage.getItem(layoutKey) === "list" ? "list" : "row";
    } catch {
      return "row";
    }
  });
  const toggleLayout = useCallback(() => {
    setLayout((current) => {
      const next: PinnedLayout = current === "row" ? "list" : "row";
      try {
        window.localStorage.setItem(layoutKey, next);
      } catch {
        // Not persisted when storage is unavailable.
      }
      return next;
    });
  }, []);
  return { layout, toggleLayout };
}

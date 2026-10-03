import type { Coworker } from "@shared/contracts";

/** Keeps the primary coworker first and the rest in their existing order. */
export function sortCoworkers(coworkers: Coworker[]): Coworker[] {
  return [...coworkers].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
}

export function allCoworkerTags(coworkers: Coworker[]): string[] {
  const counts = new Map<string, number>();
  for (const coworker of coworkers) {
    for (const tag of coworker.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

/**
 * Every whitespace-separated term must match. `#tag` terms match tags only
 * (by prefix); plain terms match name, role, description or any tag.
 */
export function filterCoworkers(coworkers: Coworker[], query: string): Coworker[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return coworkers;
  return coworkers.filter((coworker) => {
    const text = [coworker.name, coworker.role, coworker.description ?? "", ...coworker.tags]
      .join("\n")
      .toLocaleLowerCase();
    return terms.every((term) =>
      term.startsWith("#")
        ? term.length > 1 && coworker.tags.some((tag) => tag.startsWith(term.slice(1)))
        : text.includes(term),
    );
  });
}

export function normalizeTag(value: string): string {
  return value.trim().replace(/^#+/, "").trim().toLocaleLowerCase().slice(0, 24);
}

/** The partial name after a trailing "@" being typed, or null when not mentioning. */
export function mentionQuery(draft: string): string | null {
  const match = draft.match(/(?:^|\s)@([^@\n]*)$/);
  return match ? (match[1] ?? "").trim().toLocaleLowerCase() : null;
}

/** Coworkers matching the "@" being typed, by name, role or tag. */
export function mentionSuggestions<T extends Pick<Coworker, "id" | "name" | "role" | "tags">>(
  draft: string,
  candidates: T[],
  alreadyMentioned: string[] = [],
): T[] {
  const query = mentionQuery(draft);
  if (query === null) return [];
  return candidates.filter(
    (candidate) =>
      !alreadyMentioned.includes(candidate.id) &&
      `${candidate.name} ${candidate.role} ${candidate.tags.join(" ")}`
        .toLocaleLowerCase()
        .includes(query),
  );
}

/** Replaces the "@" being typed with the chosen coworker's full name. */
export function insertMention(draft: string, name: string): string {
  const atIndex = draft.lastIndexOf("@");
  const prefix = atIndex >= 0 ? draft.slice(0, atIndex) : `${draft} `;
  return `${prefix}@${name} `;
}

/** Starts a reply to a coworker: puts "@Name " in front unless the draft already tags them. */
export function withReplyTag(draft: string, name: string): string {
  const tag = `@${name}`;
  if (new RegExp(`(^|\\s)${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)`, "i").test(draft)) return draft;
  const rest = draft.trimStart();
  return rest ? `${tag} ${rest}` : `${tag} `;
}

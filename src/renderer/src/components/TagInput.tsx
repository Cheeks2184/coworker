import { useState, type KeyboardEvent } from "react";
import { normalizeTag } from "../lib/coworker-filter";

const maxTags = 10;

export function TagInput({
  tags,
  onChange,
  disabled,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");

  function commit(raw: string) {
    const tag = normalizeTag(raw);
    setDraft("");
    if (!tag || tags.includes(tag) || tags.length >= maxTags) return;
    onChange([...tags, tag]);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Backspace" && draft === "" && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  }

  return (
    <div className="tag-input">
      {tags.map((tag) => (
        <span className="tag-chip" key={tag}>
          #{tag}
          <button
            aria-label={`Remove tag ${tag}`}
            disabled={disabled}
            onClick={() => onChange(tags.filter((candidate) => candidate !== tag))}
            type="button"
          >
            ×
          </button>
        </span>
      ))}
      <input
        aria-label="Add tag"
        disabled={disabled || tags.length >= maxTags}
        maxLength={24}
        onBlur={() => commit(draft)}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={tags.length === 0 ? "Add tags, press Enter" : ""}
        value={draft}
      />
    </div>
  );
}

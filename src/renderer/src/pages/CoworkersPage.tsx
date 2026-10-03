import { useMemo, useState, type FormEvent } from "react";
import type {
  AppSettings,
  Coworker,
  Integration,
  ModelEndpoint,
  RemoteModelProvider,
} from "@shared/contracts";
import { Icon } from "../components/Icon";
import { ModalPortal } from "../components/ModalPortal";
import { ModelSelector } from "../components/ModelSelector";
import { ProviderSelect } from "../components/ProviderSelect";
import { TagInput } from "../components/TagInput";
import { AvatarPhotoControl } from "../components/AvatarPhotoControl";
import {
  CoworkerMoreButton,
  menuPositionFor,
  useCoworkerActions,
} from "../components/CoworkerActions";
import { splitPinnedCoworkers } from "../lib/pinned-coworkers";
import { allCoworkerTags, filterCoworkers, sortCoworkers } from "../lib/coworker-filter";
import {
  CoworkerAvatar,
  CoworkerModelBadge,
  PageHeader,
  StatusLabel,
  DiscordLinkBadge,
  coworkerAvatarCount,
  coworkerAvatarVisual,
  discordConnectionCount,
  TelegramLinkBadge,
  telegramConnectionCount,
} from "../components/Primitives";

type CoworkerView = "cards" | "list";

export function CoworkersPage({
  coworkers,
  settings,
  modelEndpoints = [],
  integrations = [],
  onOpen,
  onChanged,
  onOpenModelSettings,
}: {
  coworkers: Coworker[];
  settings: AppSettings;
  modelEndpoints?: ModelEndpoint[];
  integrations?: Integration[];
  onOpen: (coworker: Coworker) => void;
  onChanged: () => Promise<void>;
  onOpenModelSettings?: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const actions = useCoworkerActions({ coworkers, onChanged });
  const tags = useMemo(() => allCoworkerTags(coworkers), [coworkers]);
  // Primary first, then pinned coworkers, then everyone else.
  const visible = useMemo(() => {
    const { pinned, others } = splitPinnedCoworkers(sortCoworkers(coworkers), actions.pinnedIds);
    return filterCoworkers([...pinned, ...others], query);
  }, [coworkers, query, actions.pinnedIds]);
  const activeTags = new Set(
    query.toLocaleLowerCase().split(/\s+/).filter((term) => term.startsWith("#")).map((term) => term.slice(1)),
  );

  function toggleTagFilter(tag: string) {
    const terms = query.split(/\s+/).filter(Boolean);
    const token = `#${tag}`;
    const has = terms.some((term) => term.toLocaleLowerCase() === token);
    setQuery(
      (has ? terms.filter((term) => term.toLocaleLowerCase() !== token) : [...terms, token]).join(" "),
    );
  }
  const [view, setView] = useState<CoworkerView>(() =>
    window.localStorage.getItem("coworker-directory-view") === "list" ? "list" : "cards",
  );

  function changeView(nextView: CoworkerView) {
    setView(nextView);
    window.localStorage.setItem("coworker-directory-view", nextView);
  }

  return (
    <div className="page coworkers-page">
      <PageHeader
        eyebrow="Team"
        title="Coworkers"
        description="Each coworker has an independent runtime, workspace, and one focused task queue."
        action={
          <div className="coworker-header-actions">
            <div className="directory-view-switch" role="group" aria-label="Coworker view">
              <button
                aria-pressed={view === "cards"}
                className={view === "cards" ? "active" : ""}
                onClick={() => changeView("cards")}
                title="Card view"
                type="button"
              >
                <Icon name="grid" />
                Cards
              </button>
              <button
                aria-pressed={view === "list"}
                className={view === "list" ? "active" : ""}
                onClick={() => changeView("list")}
                title="Compact list view"
                type="button"
              >
                <Icon name="list" />
                List
              </button>
            </div>
            <button className="primary-button" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Create coworker
            </button>
          </div>
        }
      />

      <div className="coworker-directory-head">
        <span>
          {query.trim()
            ? `${visible.length} of ${coworkers.length} coworkers`
            : `${coworkers.length} coworker${coworkers.length === 1 ? "" : "s"}`}
        </span>
        <label className="coworker-search">
          <Icon name="search" />
          <input
            aria-label="Search coworkers"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name, role, or #tag"
            type="search"
            value={query}
          />
        </label>
        <small>
          {view === "cards" ? "Workspace cards" : "Compact directory"}
        </small>
      </div>

      {tags.length > 0 ? (
        <div className="coworker-tag-filter" role="group" aria-label="Filter by tag">
          {tags.map((tag) => (
            <button
              aria-pressed={activeTags.has(tag)}
              className="tag-chip"
              key={tag}
              onClick={() => toggleTagFilter(tag)}
              type="button"
            >
              #{tag}
            </button>
          ))}
        </div>
      ) : null}

      <div className={`coworker-roster ${view}`}>
        {coworkers.length > 0 && visible.length === 0 ? (
          <div className="coworker-directory-empty">
            <h3>No coworkers match “{query.trim()}”</h3>
            <button className="text-button" onClick={() => setQuery("")} type="button">
              Clear search
            </button>
          </div>
        ) : null}
        {visible.map((coworker) => (
          <div className="roster-card-wrap" key={coworker.id}>
          <button
            className="roster-card"
            onClick={() => onOpen(coworker)}
            onContextMenu={(event) => {
              event.preventDefault();
              actions.openMenu(coworker, menuPositionFor(event));
            }}
          >
            <CoworkerAvatar className="large-avatar" coworker={coworker} />
            <span className="roster-copy">
              <span className="roster-name">
                <strong>{coworker.name}</strong>
                {coworker.isPrimary ? <span className="primary-badge">Primary</span> : null}
                <StatusLabel status={coworker.runtimeStatus} />
              </span>
              <h3>{coworker.role}</h3>
              <p>{coworker.description || "Ready to take on a focused responsibility."}</p>
              {coworker.tags.length > 0 ? (
                <span className="roster-tags">
                  {coworker.tags.map((tag) => (
                    <span className="tag-chip" key={tag}>
                      #{tag}
                    </span>
                  ))}
                </span>
              ) : null}
            </span>
            <span className="roster-meta">
              <span>
                <Icon name="settings" />
                {coworker.enabledTools.length} tools
              </span>
              <CoworkerModelBadge coworker={coworker} modelEndpoints={modelEndpoints} />
              {telegramConnectionCount(integrations, coworker.id) > 0 ? (
                <TelegramLinkBadge count={telegramConnectionCount(integrations, coworker.id)} />
              ) : null}
              {discordConnectionCount(integrations, coworker.id) > 0 ? (
                <DiscordLinkBadge count={discordConnectionCount(integrations, coworker.id)} />
              ) : null}
            </span>
            <span className="roster-open-cta">
              <span>Work with {coworker.name}</span>
              <Icon name="arrow" />
            </span>
          </button>
          <CoworkerMoreButton
            className="roster-card-more"
            coworker={coworker}
            onOpen={(position) => actions.openMenu(coworker, position)}
          />
          </div>
        ))}
        {coworkers.length === 0 ? (
          <div className="coworker-directory-empty">
            <span className="empty-icon">
              <Icon name="people" />
            </span>
            <h3>Your team is empty</h3>
            <p>Create a coworker with a focused role and controlled tools.</p>
            <button className="primary-button" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Create coworker
            </button>
          </div>
        ) : null}
      </div>

      {actions.element}

      {creating ? (
        <CreateCoworkerModal
          settings={settings}
          modelEndpoints={modelEndpoints}
          onChanged={onChanged}
          onClose={() => setCreating(false)}
          onCreated={onOpen}
          onOpenModelSettings={onOpenModelSettings}
        />
      ) : null}
    </div>
  );
}

export function CreateCoworkerModal({
  settings,
  modelEndpoints = [],
  onChanged,
  onClose,
  onCreated,
  onOpenModelSettings,
}: {
  settings: Pick<AppSettings, "defaultModelProvider" | "defaultModelName">;
  modelEndpoints?: ModelEndpoint[];
  onChanged: () => Promise<void>;
  onClose: () => void;
  onCreated: (coworker: Coworker) => void;
  onOpenModelSettings?: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<RemoteModelProvider | "">(
    settings.defaultModelProvider ?? "",
  );
  const [modelName, setModelName] = useState(settings.defaultModelName ?? "");
  const [tags, setTags] = useState<string[]>([]);
  const [photo, setPhoto] = useState<string | null>(null);
  const [avatarChoice, setAvatarChoice] = useState(() =>
    Math.floor(Math.random() * coworkerAvatarCount),
  );

  async function createCoworker(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const role = String(data.get("role") ?? "").trim();
    if (!provider || !modelName) {
      setError("No model configured. Add an API key and choose a default model in Settings.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const coworker = await window.coworker.coworkers.create({
        name,
        role,
        avatarIndex: avatarChoice,
        ...(photo ? { avatarImage: photo } : {}),
        tags,
        description: String(data.get("description") ?? "").trim(),
        systemPrompt: `You are ${name}, a ${role}. Work carefully, use only the tools provided, and never claim an external action succeeded unless its tool confirms success.`,
        modelProvider: provider,
        modelName,
        enabledTools: [
          "files.list",
          "files.read",
          "files.write",
          "documents.export",
          "email.create_draft",
          "schedules.create",
          "email.send",
        ],
        policies: { "email.send": "approval", "schedules.create": "approval" },
      });
      onClose();
      await onChanged();
      onCreated(coworker);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalPortal>
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-card create-coworker-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-coworker-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="eyebrow">New desk</span>
        <h2 id="create-coworker-title">Create a coworker</h2>
        <p>Start with a clear responsibility. Tools remain controlled by the app.</p>
        <form onSubmit={createCoworker} className="form-stack">
          <div className="avatar-picker">
            <span>Avatar</span>
            <div className="avatar-picker-grid" role="radiogroup" aria-label="Coworker avatar">
              {Array.from({ length: coworkerAvatarCount }, (_, index) => {
                const visual = coworkerAvatarVisual(index);
                return (
                  <button
                    aria-checked={index === avatarChoice}
                    aria-label={`Avatar ${index + 1}`}
                    className={
                      index === avatarChoice ? "avatar-option selected" : "avatar-option"
                    }
                    key={index}
                    onClick={() => setAvatarChoice(index)}
                    role="radio"
                    style={{ backgroundColor: visual.color }}
                    type="button"
                  >
                    <img alt="" src={visual.image} />
                  </button>
                );
              })}
            </div>
            <AvatarPhotoControl disabled={saving} onChange={setPhoto} photo={photo} />
          </div>
          <label>
            <span>Name</span>
            <input name="name" placeholder="e.g. Mia" required maxLength={80} autoFocus />
          </label>
          <label>
            <span>Role</span>
            <input name="role" placeholder="e.g. Support Coworker" required maxLength={120} />
          </label>
          <label>
            <span>What should they own?</span>
            <textarea
              name="description"
              placeholder="Triage customer questions and prepare clear replies."
              rows={3}
              maxLength={1000}
            />
          </label>
          <label>
            <span>Tags</span>
            <TagInput disabled={saving} onChange={setTags} tags={tags} />
          </label>
          {provider ? (
            <>
              <ProviderSelect
                disabled={saving}
                modelEndpoints={modelEndpoints}
                onChange={(next) => {
                  setProvider(next);
                  setModelName("");
                }}
                value={provider}
              />
              <ModelSelector
                disabled={saving}
                onChange={setModelName}
                provider={provider}
                value={modelName}
              />
            </>
          ) : (
            <div className="model-not-configured create-coworker-model-empty">
              <strong>No model configured</strong>
              <small>Add an API key and select a default model in Settings before creating a coworker.</small>
              {onOpenModelSettings ? (
                <button className="text-button" onClick={onOpenModelSettings} type="button">
                  Open model settings
                </button>
              ) : null}
            </div>
          )}
          {error ? <div className="inline-error">{error}</div> : null}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary-button" disabled={saving || !modelName}>
              {saving ? "Creating…" : "Create coworker"}
            </button>
          </div>
        </form>
      </section>
    </div>
    </ModalPortal>
  );
}

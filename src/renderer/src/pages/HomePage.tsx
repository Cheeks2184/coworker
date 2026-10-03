import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { AppSnapshot, Approval, Artifact, Coworker } from "@shared/contracts";
import { formatClockTime } from "@shared/time";
import { artifactExtension } from "../components/ArtifactActions";
import { ChatMarkdown } from "../components/ChatMarkdown";
import { Icon } from "../components/Icon";
import { CoworkerAvatar, EmptyState } from "../components/Primitives";
import { approvalPreviewRows } from "../lib/approval-preview";
import { sortCoworkers } from "../lib/coworker-filter";
import {
  allActivity,
  approvalHighlights,
  buildTeamFeed,
  isSameDay,
  matchesFilters,
  recentArtifacts,
  teamStats,
  type TeamFeedFilters,
  type TeamFeedItem,
  type TeamFeedRange,
  type TeamFeedSection,
  type TeamFeedState,
  type TeamFeedStatus,
} from "../lib/team-feed";

const sectionLabels: Record<TeamFeedSection, string> = {
  now: "Now",
  today: "Earlier today",
  yesterday: "Yesterday",
  earlier: "Earlier",
};

const rangeLabels: Record<TeamFeedRange, string> = {
  any: "Any time",
  today: "Today",
  yesterday: "Yesterday",
  week: "Last 7 days",
};

const statusLabels: Record<TeamFeedStatus, string> = {
  any: "Any status",
  "needs-you": "Needs you",
  "in-progress": "In progress",
  done: "Done",
  failed: "Failed",
};

/** Matches the status pills: green for live work, amber for decisions, blue for done. */
const statusDots: Record<Exclude<TeamFeedStatus, "any">, string> = {
  "needs-you": "waiting",
  "in-progress": "running",
  done: "done",
  failed: "failed",
};

const stateChips: Partial<Record<TeamFeedState, string>> = {
  running: "Running",
  queued: "Queued",
  "needs-you": "Needs you",
  failed: "Failed",
};

type Decide = (approval: Approval, decision: "approve" | "reject") => Promise<void>;

/** Cards rendered per step of the continuous scroll. */
const feedPageSize = 12;

export function HomePage({
  snapshot,
  onOpenCoworker,
  onChatWithTeam,
  onOpenApprovals,
  onManageCoworkers,
  onOpenFiles,
  onChanged,
}: {
  snapshot: AppSnapshot;
  onOpenCoworker: (coworker: Coworker, conversationId?: string) => void;
  onChatWithTeam: () => void;
  onOpenApprovals: () => void;
  onManageCoworkers: () => void;
  onOpenFiles: () => void;
  onChanged: () => Promise<void>;
}) {
  const now = new Date();
  const stats = teamStats(snapshot, now);
  const feed = useMemo(() => buildTeamFeed(snapshot), [snapshot]);
  const coworkers = sortCoworkers(snapshot.coworkers);
  const availableCoworkers = coworkers.filter((coworker) => coworker.status === "active");
  const [filters, setFilters] = useState<TeamFeedFilters>(allActivity);
  const [visibleCount, setVisibleCount] = useState(feedPageSize);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const filtered = feed.filter((item) => matchesFilters(item, filters, now));
  const visible = filtered.slice(0, visibleCount);
  const filtering = filters.range !== "any" || filters.status !== "any" || filters.coworkerId !== null;
  const needsYou = feed.filter((item) => item.state === "needs-you").length;
  const replyableThreads = new Set(
    snapshot.conversations
      .filter((conversation) => !conversation.archivedAt)
      .map((conversation) => conversation.id),
  );
  const loadMore = useCallback(() => setVisibleCount((count) => count + feedPageSize), []);

  function changeFilters(next: Partial<TeamFeedFilters>) {
    setFilters((current) => ({ ...current, ...next }));
    setVisibleCount(feedPageSize);
  }

  const decide = useCallback(
    async (approval: Approval, decision: "approve" | "reject") => {
      setDeciding(approval.id);
      setDecisionError(null);
      try {
        await window.coworker.approvals.decide({ approvalId: approval.id, decision });
        await onChanged();
      } catch (error) {
        setDecisionError(error instanceof Error ? error.message : String(error));
      } finally {
        setDeciding(null);
      }
    },
    [onChanged],
  );

  return (
    <div className="page team-room">
      <div className="team-room-main">
        <header className="team-greeting">
          <h1>
            <TimeOfDayArt period={dayPeriod(now)} />
            Good {dayPeriod(now)}!
          </h1>
          <p>Here’s what our team is busy with…</p>
        </header>

        {snapshot.coworkers.length === 0 ? (
          <EmptyState
            icon="people"
            title="Your team is empty"
            body="Create a coworker with a focused role and controlled tools."
            action={
              <button className="primary-button" onClick={onManageCoworkers} type="button">
                Create coworker
              </button>
            }
          />
        ) : (
          <>
            {availableCoworkers.length > 0 ? (
              <TaskComposer
                coworkers={availableCoworkers}
                onChanged={onChanged}
                onOpenCoworker={onOpenCoworker}
              />
            ) : null}

            <div aria-label="Team status" className="team-pills">
              <span className="team-pill">
                <i className="team-dot running" />
                <strong>{stats.working}</strong> running now
              </span>
              <span className="team-pill">
                <i className="team-dot waiting" />
                <strong>{stats.waiting}</strong> {stats.waiting === 1 ? "decision" : "decisions"} waiting on you
              </span>
              <span className="team-pill">
                <i className="team-dot done" />
                <strong>{stats.doneToday}</strong> {stats.doneToday === 1 ? "task" : "tasks"} done today
              </span>
            </div>

            <div aria-label="Filter activity" className="team-filters" role="group">
              <div aria-label="When" className="team-range" role="group">
                <Icon name="clock" />
                {(Object.keys(rangeLabels) as TeamFeedRange[]).map((range) => (
                  <button
                    aria-pressed={filters.range === range}
                    key={range}
                    onClick={() => changeFilters({ range })}
                    type="button"
                  >
                    {rangeLabels[range]}
                  </button>
                ))}
              </div>
              <div className="team-filter-menus">
                <FilterMenu
                  label="Status"
                  onChange={(status) => changeFilters({ status })}
                  options={(Object.keys(statusLabels) as TeamFeedStatus[]).map((status) => ({
                    value: status,
                    label: statusLabels[status],
                    mark: status === "any" ? <Icon name="activity" /> : <i className={`team-dot ${statusDots[status]}`} />,
                    count: status === "needs-you" ? needsYou : 0,
                  }))}
                  value={filters.status}
                />
                <FilterMenu
                  label="Coworker"
                  onChange={(coworkerId) => changeFilters({ coworkerId: coworkerId || null })}
                  options={[
                    { value: "", label: "Everyone", mark: <Icon name="people" /> },
                    ...coworkers.map((coworker) => ({
                      value: coworker.id,
                      label: coworker.name,
                      mark: <CoworkerAvatar className="team-filter-avatar" coworker={coworker} />,
                    })),
                  ]}
                  value={filters.coworkerId ?? ""}
                />
              </div>
            </div>

            {decisionError ? (
              <p className="team-error" role="alert">
                {decisionError}
              </p>
            ) : null}

            {visible.length === 0 ? (
              <p className="team-feed-empty">
                {emptyFeedText(filters, coworkers)}
                {filtering ? (
                  <button className="team-link" onClick={() => changeFilters(allActivity)} type="button">
                    Clear filters
                  </button>
                ) : null}
              </p>
            ) : (
              (Object.keys(sectionLabels) as TeamFeedSection[]).map((section) => {
                const items = visible.filter((item) => item.section === section);
                return items.length === 0 ? null : (
                  <section aria-label={sectionLabels[section]} className="team-feed-section" key={section}>
                    <h2 className="team-feed-label">{sectionLabels[section]}</h2>
                    {items.map((item) => (
                      <FeedCard
                        artifacts={snapshot.artifacts}
                        canReply={replyableThreads.has(item.task.threadId)}
                        deciding={deciding !== null && deciding === item.approval?.id}
                        item={item}
                        key={item.id}
                        onChanged={onChanged}
                        onDecide={decide}
                        onOpenCoworker={onOpenCoworker}
                      />
                    ))}
                  </section>
                );
              })
            )}
            {filtered.length > visible.length ? (
              // Remounting per page re-checks whether the end is still in view.
              <FeedMore key={visible.length} onLoadMore={loadMore} />
            ) : null}
          </>
        )}
      </div>

      <aside aria-label="Team overview" className="team-room-rail">
        <div className="team-room-rail-inner">
          <RailClock />
          {coworkers.length > 0 ? <CrewCard coworkers={coworkers} onOpen={onChatWithTeam} /> : null}
          <ApprovalsPanel
            approvals={snapshot.approvals}
            coworkers={coworkers}
            deciding={deciding}
            onDecide={decide}
            onOpenApprovals={onOpenApprovals}
          />
          <RecentFiles artifacts={snapshot.artifacts} coworkers={coworkers} onOpenFiles={onOpenFiles} />
        </div>
      </aside>
    </div>
  );
}

function TaskComposer({
  coworkers,
  onChanged,
  onOpenCoworker,
}: {
  coworkers: Coworker[];
  onChanged: () => Promise<void>;
  onOpenCoworker: (coworker: Coworker, conversationId?: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [assigneeId, setAssigneeId] = useState<string | null>(coworkers[0]?.id ?? null);
  const [dispatching, setDispatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const assignee =
    coworkers.find((coworker) => coworker.id === assigneeId) ?? coworkers[0] ?? null;

  useEffect(() => {
    function focusComposer(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.current?.focus();
      }
    }
    window.addEventListener("keydown", focusComposer);
    return () => window.removeEventListener("keydown", focusComposer);
  }, []);

  async function putToWork(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !assignee || dispatching) return;
    setDispatching(true);
    setError(null);
    try {
      // Every composer task starts its own conversation; the conversation
      // takes the task's title as soon as the task binds to it.
      const conversation = await window.coworker.conversations.create({
        coworkerId: assignee.id,
      });
      await window.coworker.tasks.create({
        coworkerId: assignee.id,
        title: composerTaskTitle(text),
        input: text,
        threadId: conversation.id,
      });
      await onChanged();
      setDraft("");
      onOpenCoworker(assignee, conversation.id);
    } catch (dispatchError) {
      setError(dispatchError instanceof Error ? dispatchError.message : String(dispatchError));
    } finally {
      setDispatching(false);
    }
  }

  return (
    <form className="team-composer" onSubmit={putToWork}>
      <input
        aria-label="Describe the task"
        disabled={dispatching}
        maxLength={100_000}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Ask a coworker to…"
        ref={input}
        value={draft}
      />
      <div className="team-composer-bar">
        <small>Assign to</small>
        {coworkers.map((coworker) => (
          <button
            aria-pressed={assignee?.id === coworker.id}
            className={assignee?.id === coworker.id ? "team-chip selected" : "team-chip"}
            disabled={dispatching}
            key={coworker.id}
            onClick={() => setAssigneeId(coworker.id)}
            type="button"
          >
            <span aria-hidden="true">
              <CoworkerAvatar className="team-chip-avatar" coworker={coworker} />
            </span>
            {coworker.name}
            {coworker.isPrimary ? <span className="team-chip-note"> · primary</span> : null}
          </button>
        ))}
        <kbd>{window.coworker.platform === "darwin" ? "⌘ K" : "Ctrl K"}</kbd>
        <button
          className="team-composer-send"
          disabled={dispatching || !draft.trim() || !assignee}
          type="submit"
        >
          {dispatching ? "Starting…" : `Start${assignee ? ` ${assignee.name}` : ""}`}
          <Icon name="arrow" />
        </button>
      </div>
      {error ? (
        <small className="team-error" role="alert">
          {error}
        </small>
      ) : null}
    </form>
  );
}

interface FilterOption<T extends string> {
  value: T;
  label: string;
  /** An icon, dot, or avatar shown before the label. */
  mark: ReactNode;
  count?: number;
}

/** A button showing the current choice that opens a menu of the others; the first option filters nothing. */
function FilterMenu<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<FilterOption<T>>;
  value: T;
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0]!;

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="team-filter-menu" ref={root}>
      <button
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`${label}: ${selected.label}`}
        className={selected === options[0] ? "team-filter-button" : "team-filter-button filtering"}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span aria-hidden="true" className="team-filter-mark">
          {selected.mark}
        </span>
        {selected.label}
        <Icon className="team-filter-chevron" name="arrow" />
      </button>
      {open ? (
        <div aria-label={label} className="team-filter-options" id={listboxId} role="listbox">
          {options.map((option) => (
            <button
              aria-selected={option.value === value}
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              role="option"
              type="button"
            >
              <span aria-hidden="true" className="team-filter-mark">
                {option.mark}
              </span>
              {option.label}
              {option.count ? <span className="team-count">{option.count}</span> : null}
              {option.value === value ? <Icon className="team-filter-check" name="check" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Memoized so loading the next page renders only the new cards.
const FeedCard = memo(function FeedCard({
  item,
  artifacts,
  canReply,
  deciding,
  onDecide,
  onOpenCoworker,
  onChanged,
}: {
  item: TeamFeedItem;
  artifacts: Artifact[];
  canReply: boolean;
  deciding: boolean;
  onDecide: Decide;
  onOpenCoworker: (coworker: Coworker, conversationId?: string) => void;
  onChanged: () => Promise<void>;
}) {
  const { coworker, approval } = item;
  const onOpenChat = () => onOpenCoworker(coworker, item.task.threadId);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState(false);
  const chip = stateChips[item.state];

  useLayoutEffect(() => {
    const element = content.current;
    setClamped(Boolean(element && element.scrollHeight > element.clientHeight + 1));
  }, [item.body]);

  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = reply.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await window.coworker.conversations.send({
        conversationId: item.task.threadId,
        clientMessageId: crypto.randomUUID(),
        content: text,
        mentionedCoworkerIds: [],
      });
      setReply("");
      setReplying(false);
      await onChanged();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setSending(false);
    }
  }

  return (
    <article className={item.state === "needs-you" ? "team-card attention" : "team-card"}>
      <CoworkerAvatar className="team-card-avatar" coworker={coworker} />
      <div className="team-card-main">
        <header className="team-card-head">
          <strong>{coworker.name}</strong>
          <span className="team-card-role">{coworker.role}</span>
          {chip ? <span className={`team-state ${item.state}`}>{chip}</span> : null}
          <time dateTime={item.at}>{compactAge(item.at)}</time>
        </header>
        <p className="team-card-headline">{headline(item)}</p>

        {item.body ? (
          <div className={clamped ? "team-card-content clamped" : "team-card-content"} ref={content}>
            <ChatMarkdown artifacts={artifacts.filter((artifact) => artifact.coworkerId === coworker.id)}>
              {item.body}
            </ChatMarkdown>
          </div>
        ) : approval ? (
          <dl className="team-card-preview">
            {approvalPreviewRows(approval).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {item.state === "running" ? (
          <div className="team-progress" role="status">
            <span aria-hidden="true" className="team-progress-track">
              <span />
            </span>
            Working…
          </div>
        ) : null}

        <footer className="team-card-foot">
          {approval ? (
            <span className="team-card-decision">
              <button
                className="team-approve"
                disabled={deciding}
                onClick={() => void onDecide(approval, "approve")}
                type="button"
              >
                {approval.actionType.endsWith(".send") ? "Approve & send" : "Approve"}
              </button>
              <button
                className="team-decline"
                disabled={deciding}
                onClick={() => void onDecide(approval, "reject")}
                type="button"
              >
                Decline
              </button>
              <small>Needs your approval</small>
            </span>
          ) : (
            <small className="team-card-origin">{origin(item)}</small>
          )}
          <span className="team-card-links">
            <button
              aria-expanded={canReply ? replying : undefined}
              className="team-link"
              onClick={() => (canReply ? setReplying((open) => !open) : onOpenChat())}
              type="button"
            >
              <Icon name="reply" />
              Reply
            </button>
            <button className="team-link" onClick={onOpenChat} type="button">
              Open chat
              <Icon name="arrow" />
            </button>
          </span>
        </footer>

        {replying ? (
          <form className="team-card-reply" onSubmit={sendReply}>
            <input
              aria-label={`Reply to ${coworker.name}`}
              autoFocus
              disabled={sending}
              onChange={(event) => setReply(event.target.value)}
              placeholder={`Reply to ${coworker.name}…`}
              value={reply}
            />
            <button className="primary-button" disabled={sending || !reply.trim()} type="submit">
              {sending ? "Sending…" : "Send"}
            </button>
          </form>
        ) : null}
        {error ? (
          <small className="team-error" role="alert">
            {error}
          </small>
        ) : null}
      </div>
    </article>
  );
});

/** Loads the next page as the end of the feed nears the bottom of its scroll area. */
function FeedMore({ onLoadMore }: { onLoadMore: () => void }) {
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = sentinel.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { root: scrollParent(element), rootMargin: "0px 0px 600px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [onLoadMore]);

  return (
    <div className="team-feed-more" ref={sentinel}>
      <button className="team-link" onClick={onLoadMore} type="button">
        Show more
      </button>
    </div>
  );
}

/** The feed column scrolls in the wide layout and the whole page does when stacked. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/** The current date and time, refreshed at the start of each minute. */
function RailClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const scheduleNextMinute = () => {
      timer = setTimeout(() => {
        setNow(new Date());
        scheduleNextMinute();
      }, 60_000 - (Date.now() % 60_000));
    };
    scheduleNextMinute();
    return () => clearTimeout(timer);
  }, []);

  return (
    <section aria-label="Current time" className="team-clock">
      <time dateTime={now.toISOString()}>
        <strong>{formatClockTime(now)}</strong>
        <span>
          {now.toLocaleDateString(undefined, {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
        </span>
      </time>
    </section>
  );
}

function CrewCard({ coworkers, onOpen }: { coworkers: Coworker[]; onOpen: () => void }) {
  const shown = coworkers.slice(0, 4);
  const more = coworkers.length - shown.length;
  return (
    <section aria-label="Your team" className="team-crew">
      <span aria-hidden="true" className="team-avatar-stack">
        {shown.map((coworker) => (
          <CoworkerAvatar className="team-stack-avatar" coworker={coworker} key={coworker.id} />
        ))}
        {more > 0 ? <span className="team-stack-more">+{more}</span> : null}
      </span>
      <button className="team-crew-button" onClick={onOpen} type="button">
        Chat with team
        <Icon name="arrow" />
      </button>
    </section>
  );
}

function ApprovalsPanel({
  approvals,
  coworkers,
  deciding,
  onDecide,
  onOpenApprovals,
}: {
  approvals: Approval[];
  coworkers: Coworker[];
  deciding: string | null;
  onDecide: Decide;
  onOpenApprovals: () => void;
}) {
  const pending = approvals.filter((approval) => approval.status === "PENDING").length;
  const rows = approvalHighlights(approvals);
  return (
    <section aria-label="Approvals" className="team-rail-section">
      <header>
        <h2>
          Approvals
          {pending > 0 ? <span className="team-count">{pending}</span> : null}
        </h2>
        <button className="team-link" onClick={onOpenApprovals} type="button">
          Rules
          <Icon name="arrow" />
        </button>
      </header>
      <div className="team-rail-list">
        {rows.length === 0 ? (
          <p className="team-rail-empty">Nothing is waiting on you.</p>
        ) : (
          rows.map((approval) => {
            const state = approvalState(approval);
            const owner = coworkers.find((coworker) => coworker.id === approval.coworkerId);
            return (
              <div className={`team-approval ${state}`} key={approval.id}>
                <span className="team-approval-icon">
                  <Icon name={state === "pending" ? "alert" : state === "approved" ? "check" : "close"} />
                </span>
                <span className="team-approval-copy">
                  <strong>{approval.summary}</strong>
                  <small>
                    {[owner?.name ?? "Coworker", approval.actionType.split(".")[0], decisionLabels[state]]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                  {state === "pending" ? (
                    <span className="team-approval-actions">
                      <button
                        className="team-approve"
                        disabled={deciding === approval.id}
                        onClick={() => void onDecide(approval, "approve")}
                        type="button"
                      >
                        Approve
                      </button>
                      <button
                        className="team-decline"
                        disabled={deciding === approval.id}
                        onClick={() => void onDecide(approval, "reject")}
                        type="button"
                      >
                        Decline
                      </button>
                    </span>
                  ) : null}
                </span>
                <time dateTime={approval.decidedAt ?? approval.createdAt}>
                  {compactAge(approval.decidedAt ?? approval.createdAt)}
                </time>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

function RecentFiles({
  artifacts,
  coworkers,
  onOpenFiles,
}: {
  artifacts: Artifact[];
  coworkers: Coworker[];
  onOpenFiles: () => void;
}) {
  const files = recentArtifacts(artifacts);
  return (
    <section aria-label="Recent files" className="team-rail-section">
      <header>
        <h2>Recent files</h2>
        <button className="team-link" onClick={onOpenFiles} type="button">
          All files
          <Icon name="arrow" />
        </button>
      </header>
      <div className="team-rail-list">
        {files.length === 0 ? (
          <p className="team-rail-empty">Files your coworkers create show up here.</p>
        ) : (
          files.map((artifact) => {
            const owner = coworkers.find((coworker) => coworker.id === artifact.coworkerId);
            return (
              <button
                className="team-file"
                key={artifact.id}
                onClick={() => void window.coworker.artifacts.open(artifact.id).catch(() => undefined)}
                title={`Open ${artifact.name}`}
                type="button"
              >
                <span className="team-file-type">{artifactExtension(artifact)}</span>
                <span className="team-file-copy">
                  <strong>{artifact.name}</strong>
                  <small>
                    {owner ? (
                      <span aria-hidden="true">
                        <CoworkerAvatar className="team-file-owner" coworker={owner} />
                      </span>
                    ) : null}
                    {owner?.name ?? "Coworker"}
                  </small>
                </span>
                <time dateTime={artifact.createdAt}>{fileTime(artifact.createdAt)}</time>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}

type ApprovalState = "pending" | "approved" | "declined" | "expired";

const decisionLabels: Record<ApprovalState, string> = {
  pending: "",
  approved: "approved by you",
  declined: "declined",
  expired: "expired",
};

function approvalState(approval: Approval): ApprovalState {
  if (approval.status === "PENDING") return "pending";
  if (approval.status === "REJECTED") return "declined";
  if (approval.status === "EXPIRED") return "expired";
  return "approved";
}

function headline(item: TeamFeedItem): ReactNode {
  const title = <strong>{item.task.title}</strong>;
  switch (item.state) {
    case "running":
      return <>is working on {title}</>;
    case "queued":
      return <>will start {title} next</>;
    case "needs-you":
      return item.approval ? (
        <>
          wants to <strong>{lowerFirst(item.approval.summary)}</strong>
        </>
      ) : (
        <>is waiting on you for {title}</>
      );
    case "failed":
      return <>couldn’t finish {title}</>;
    default:
      return item.requester ? (
        <>
          replied to <strong>{item.requester.name}</strong>
        </>
      ) : (
        <>finished {title}</>
      );
  }
}

function origin(item: TeamFeedItem): string {
  if (item.requester) return `Asked by ${item.requester.name}`;
  if (item.task.source === "schedule") return "Scheduled task";
  if (item.task.source === "recovery") return "Resumed task";
  return "Task · started by you";
}

/** Lowercases a leading capitalized word, leaving acronyms and names like "HubSpot" alone. */
function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
}

function emptyFeedText({ range, status, coworkerId }: TeamFeedFilters, coworkers: Coworker[]): string {
  const coworker = coworkers.find((candidate) => candidate.id === coworkerId);
  if (range === "any" && status === "any") {
    return coworker
      ? `${coworker.name} hasn’t picked up any work yet.`
      : "Quiet so far. Give a coworker a task above and their work shows up here.";
  }
  if (status === "needs-you" && !coworker && range !== "yesterday") return "Nothing needs you right now.";
  return "Nothing matches these filters.";
}

type DayPeriod = "morning" | "afternoon" | "evening";

/** Late night counts as evening, so it gets the moon rather than a sunrise. */
function dayPeriod(now: Date): DayPeriod {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  return "evening";
}

/** A small illustration of the time of day beside the greeting. */
function TimeOfDayArt({ period }: { period: DayPeriod }) {
  const id = useId().replaceAll(":", "");
  const common = { "aria-hidden": true, className: "team-greeting-art", viewBox: "0 0 48 48" } as const;
  if (period === "morning") {
    return (
      <svg {...common} data-period="morning">
        <defs>
          <linearGradient id={`${id}-sun`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#ffd47a" />
            <stop offset="1" stopColor="#f59a4c" />
          </linearGradient>
        </defs>
        <path
          d="M24 11v5M9.86 16.86l3.54 3.54M38.14 16.86l-3.54 3.54"
          fill="none"
          stroke="#f5a65b"
          strokeLinecap="round"
          strokeWidth="2.6"
        />
        <path d="M13 31a11 11 0 0 1 22 0Z" fill={`url(#${id}-sun)`} />
        <path d="M5 31h38" stroke="#e58a46" strokeLinecap="round" strokeWidth="2.6" />
        <path d="M12 37h24" opacity="0.55" stroke="#e58a46" strokeLinecap="round" strokeWidth="2.6" />
      </svg>
    );
  }
  if (period === "afternoon") {
    return (
      <svg {...common} data-period="afternoon">
        <defs>
          <radialGradient cx="0.4" cy="0.35" id={`${id}-sun`} r="0.75">
            <stop offset="0" stopColor="#ffe68a" />
            <stop offset="1" stopColor="#f6b23d" />
          </radialGradient>
        </defs>
        <path
          d="M24 5v5M24 38v5M5 24h5M38 24h5M10.57 10.57l3.53 3.53M37.43 10.57l-3.53 3.53M10.57 37.43l3.53-3.53M37.43 37.43l-3.53-3.53"
          fill="none"
          stroke="#f6b23d"
          strokeLinecap="round"
          strokeWidth="2.6"
        />
        <circle cx="24" cy="24" fill={`url(#${id}-sun)`} r="10" />
      </svg>
    );
  }
  return (
    <svg {...common} data-period="evening">
      <defs>
        <linearGradient id={`${id}-moon`} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#dfe6ff" />
          <stop offset="1" stopColor="#9aa8f2" />
        </linearGradient>
      </defs>
      <path
        d="M20.55 10.07A15 15 0 1 0 35.93 30.57A13 13 0 0 1 20.55 10.07Z"
        fill={`url(#${id}-moon)`}
      />
      <path
        d="M37 6.5l1.3 3.2 3.2 1.3-3.2 1.3L37 15.5l-1.3-3.2-3.2-1.3 3.2-1.3Z"
        fill="#f7d98b"
      />
      <circle cx="42" cy="22" fill="#f7d98b" r="1.4" />
    </svg>
  );
}

function composerTaskTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() || "New task";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}

function compactAge(timestamp: string): string {
  const elapsedMs = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Minutes for the last hour, the clock time earlier today, then days. */
function fileTime(timestamp: string): string {
  const elapsedMs = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 60 * 60_000) return compactAge(timestamp);
  return isSameDay(new Date(timestamp), new Date()) ? formatClockTime(timestamp) : compactAge(timestamp);
}

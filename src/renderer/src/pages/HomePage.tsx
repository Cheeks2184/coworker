import {
  memo,
  useCallback,
  useEffect,
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
import { CoworkerAvatar, EmptyState, PageHeader } from "../components/Primitives";
import { approvalPreviewRows } from "../lib/approval-preview";
import { sortCoworkers } from "../lib/coworker-filter";
import {
  approvalHighlights,
  buildTeamFeed,
  isSameDay,
  recentArtifacts,
  teamStats,
  type TeamFeedItem,
  type TeamFeedSection,
  type TeamFeedState,
} from "../lib/team-feed";

const sectionLabels: Record<TeamFeedSection, string> = {
  now: "Now",
  today: "Earlier today",
  earlier: "Earlier",
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
  // "all", "needs-you", or a coworker id.
  const [filter, setFilter] = useState("all");
  const [visibleCount, setVisibleCount] = useState(feedPageSize);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const filtered = feed.filter((item) =>
    filter === "all"
      ? true
      : filter === "needs-you"
        ? item.state === "needs-you"
        : item.coworker.id === filter,
  );
  const visible = filtered.slice(0, visibleCount);
  const replyableThreads = new Set(
    snapshot.conversations
      .filter((conversation) => !conversation.archivedAt)
      .map((conversation) => conversation.id),
  );
  const loadMore = useCallback(() => setVisibleCount((count) => count + feedPageSize), []);

  function selectFilter(next: string) {
    setFilter(next);
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
        <PageHeader eyebrow="Team room" title={`${greeting(now)} Your team is on it.`} />
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

            <div aria-label="Filter activity" className="team-filters" role="tablist">
              <FilterTab selected={filter === "all"} onSelect={() => selectFilter("all")}>
                All activity
              </FilterTab>
              <FilterTab selected={filter === "needs-you"} onSelect={() => selectFilter("needs-you")}>
                Needs you
                {stats.waiting > 0 ? <span className="team-count">{stats.waiting}</span> : null}
              </FilterTab>
              {coworkers.map((coworker) => (
                <FilterTab
                  key={coworker.id}
                  selected={filter === coworker.id}
                  onSelect={() => selectFilter(coworker.id)}
                >
                  {coworker.name}
                </FilterTab>
              ))}
            </div>

            {decisionError ? (
              <p className="team-error" role="alert">
                {decisionError}
              </p>
            ) : null}

            {visible.length === 0 ? (
              <p className="team-feed-empty">{emptyFeedText(filter, coworkers)}</p>
            ) : (
              (["now", "today", "earlier"] as const).map((section) => {
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

function FilterTab({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-selected={selected}
      className={selected ? "team-filter selected" : "team-filter"}
      onClick={onSelect}
      role="tab"
      type="button"
    >
      {children}
    </button>
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

function emptyFeedText(filter: string, coworkers: Coworker[]): string {
  if (filter === "needs-you") return "Nothing needs you right now.";
  const coworker = coworkers.find((candidate) => candidate.id === filter);
  if (coworker) return `${coworker.name} hasn’t picked up any work yet.`;
  return "Quiet so far. Give a coworker a task above and their work shows up here.";
}

function composerTaskTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() || "New task";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return "Good morning.";
  if (hour < 18) return "Good afternoon.";
  return "Good evening.";
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

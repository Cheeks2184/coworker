import type { AppSnapshot, Approval, Artifact, Conversation, Coworker, Task } from "@shared/contracts";

export type TeamFeedState = "running" | "queued" | "needs-you" | "done" | "failed";
export type TeamFeedSection = "now" | "today" | "earlier";

export interface TeamFeedItem {
  id: string;
  task: Task;
  coworker: Coworker;
  state: TeamFeedState;
  section: TeamFeedSection;
  /** The approval this task is waiting on. */
  approval: Approval | null;
  /** For delegated work, the coworker who asked for it. */
  requester: Coworker | null;
  /** The coworker's latest message on the task, else its result or error. */
  body: string | null;
  /** When the item last changed state. */
  at: string;
}

const sectionOrder: Record<TeamFeedSection, number> = { now: 0, today: 1, earlier: 2 };

export function buildTeamFeed(snapshot: AppSnapshot, now = new Date()): TeamFeedItem[] {
  const coworkers = new Map(snapshot.coworkers.map((coworker) => [coworker.id, coworker]));
  const conversations = new Map(snapshot.conversations.map((conversation) => [conversation.id, conversation]));
  const pendingByTask = new Map(
    snapshot.approvals
      .filter((approval) => approval.status === "PENDING")
      .map((approval) => [approval.taskId, approval]),
  );
  const latestReply = new Map<string, { content: string; createdAt: string }>();
  for (const message of snapshot.messages) {
    if (message.role !== "assistant" || !message.taskId || !message.content.trim()) continue;
    const current = latestReply.get(message.taskId);
    if (!current || message.createdAt >= current.createdAt) latestReply.set(message.taskId, message);
  }

  const items = snapshot.tasks.flatMap((task): TeamFeedItem[] => {
    const coworker = coworkers.get(task.coworkerId);
    // A follow-up that relays another coworker's reply repeats that reply's card.
    if (!coworker || task.status === "CANCELLED" || task.replyFromCoworkerId) return [];
    const approval = pendingByTask.get(task.id) ?? null;
    const state = feedState(task, approval);
    const finished = state === "done" || state === "failed";
    const at =
      approval?.createdAt ?? (finished ? task.completedAt : task.startedAt) ?? task.createdAt;
    return [
      {
        id: task.id,
        task,
        coworker,
        state,
        section: finished ? (isSameDay(new Date(at), now) ? "today" : "earlier") : "now",
        approval,
        requester: requesterOf(task, conversations, coworkers),
        body:
          latestReply.get(task.id)?.content ??
          (state === "done" ? task.result : state === "failed" ? task.error : null),
        at,
      },
    ];
  });

  return items.sort(
    (left, right) => sectionOrder[left.section] - sectionOrder[right.section] || right.at.localeCompare(left.at),
  );
}

function feedState(task: Task, approval: Approval | null): TeamFeedState {
  if (approval || task.status === "WAITING_FOR_APPROVAL") return "needs-you";
  if (task.status === "RUNNING") return "running";
  if (task.status === "QUEUED") return "queued";
  if (task.status === "FAILED") return "failed";
  return "done";
}

function requesterOf(
  task: Task,
  conversations: Map<string, Conversation>,
  coworkers: Map<string, Coworker>,
): Coworker | null {
  const threadId = task.delegatedFromThreadId;
  if (!threadId) return null;
  const conversation = conversations.get(threadId);
  const requesterId =
    conversation?.coworkerId ??
    conversation?.memberIds[0] ??
    (threadId.startsWith("coworker:") ? threadId.slice("coworker:".length) : null);
  return (requesterId && coworkers.get(requesterId)) || null;
}

export function teamStats(snapshot: AppSnapshot, now = new Date()) {
  return {
    working: snapshot.coworkers.filter((coworker) => coworker.runtimeStatus === "WORKING").length,
    waiting: snapshot.approvals.filter((approval) => approval.status === "PENDING").length,
    doneToday: snapshot.tasks.filter(
      (task) =>
        task.status === "COMPLETED" && task.completedAt !== null && isSameDay(new Date(task.completedAt), now),
    ).length,
  };
}

/** Pending approvals first, then the most recent decisions. */
export function approvalHighlights(approvals: Approval[], limit = 4): Approval[] {
  const pending = approvals
    .filter((approval) => approval.status === "PENDING")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const decided = approvals
    .filter((approval) => approval.status !== "PENDING" && approval.decidedAt)
    .sort((left, right) => (right.decidedAt ?? "").localeCompare(left.decidedAt ?? ""));
  return [...pending, ...decided].slice(0, limit);
}

export function recentArtifacts(artifacts: Artifact[], limit = 4): Artifact[] {
  return [...artifacts].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, limit);
}

export function isSameDay(left: Date, right: Date): boolean {
  return left.toDateString() === right.toDateString();
}

import { randomUUID } from "node:crypto";
import type { Coworker, DesktopEvent, PeerTask, Task } from "@shared/contracts";
import type { CoworkerDatabase } from "../db/database";
import {
  buildFollowUpInput,
  coworkerRequestPrefix,
  stripCoworkerRequestPrefix,
} from "@shared/peer-follow-up";

/**
 * How deep requests may nest (A asks B, B asks C, ...). Sequential requests
 * from the same task do not nest: a follow-up returns to its sender's level.
 */
export const maxPeerDepth = 3;
/** Requests per coworker pair (both directions) in a rolling hour. */
export const peerRequestsPerHour = 30;
export const maxPeerMessageLength = 8_000;

/** What the requester originally asked, as shown in the target's conversation. */
function requestedText(database: CoworkerDatabase, requestTask: Task): string {
  try {
    if (!requestTask.sourceMessageId) return "";
    const message = database.getMessage(requestTask.sourceMessageId);
    return message.coworkerId ? stripCoworkerRequestPrefix(message.content) : message.content;
  } catch {
    return "";
  }
}

export interface PeerRosterEntry {
  id: string;
  name: string;
  role: string;
  description: string | null;
  tags: string[];
  status: Coworker["status"];
  isPrimary: boolean;
}

export interface PeerSendInput {
  /** The sending coworker, or null when the human tagged a coworker in a chat. */
  from: Coworker | null;
  /** Direct-chat coworker whose thread the human used; required when `from` is null. */
  via?: Coworker;
  to: Coworker;
  content: string;
  /** Thread where the requester continues once the work is done. */
  originThreadId: string;
  /** The sender's running task, used to measure delegation depth. */
  originTaskId?: string;
  /**
   * Report the outcome back: the sending coworker (or, for a human tag, the
   * chat's coworker) gets a follow-up in the origin thread.
   */
  expectReply: boolean;
}

export interface PeerSendResult {
  taskId: string;
  /** The target's own conversation where the work happens. */
  conversationId: string;
  depth: number;
}

/**
 * Generic delivery of messages between coworkers. It validates and persists a
 * request, hands it to the target's normal task queue and routes the answer
 * back. Which coworker to ask and what to do with the answer is decided by the
 * coworker through skills, not here.
 */
export class PeerMessaging {
  constructor(
    private readonly options: {
      database: CoworkerDatabase;
      enqueue: (coworkerId: string) => void;
      emit: (event: DesktopEvent) => void;
      onError?: (scope: string, error: unknown) => void;
    },
  ) {}

  roster(excludeCoworkerId?: string): PeerRosterEntry[] {
    return this.options.database
      .listCoworkers()
      .filter((coworker) => coworker.id !== excludeCoworkerId)
      .map((coworker) => ({
        id: coworker.id,
        name: coworker.name,
        role: coworker.role,
        description: coworker.description,
        tags: coworker.tags,
        status: coworker.status,
        isPrimary: coworker.isPrimary,
      }));
  }

  /** Resolves an id or an exact (case-insensitive) unique name. */
  resolveTarget(reference: string, senderId?: string): Coworker {
    const wanted = reference.trim();
    const candidates = this.options.database
      .listCoworkers()
      .filter((coworker) => coworker.id !== senderId);
    const byId = candidates.find((coworker) => coworker.id === wanted);
    if (byId) return byId;
    const byName = candidates.filter(
      (coworker) => coworker.name.toLocaleLowerCase() === wanted.toLocaleLowerCase(),
    );
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) {
      throw new Error(`More than one coworker is named ${wanted}; use the id from coworkers.list`);
    }
    throw new Error(`No coworker matches ${wanted}; call coworkers.list for the roster`);
  }

  send(input: PeerSendInput): PeerSendResult {
    const database = this.options.database;
    const content = input.content.trim();
    if (!content) throw new Error("A message is required");
    if (content.length > maxPeerMessageLength) {
      throw new Error(`Messages are limited to ${maxPeerMessageLength} characters`);
    }
    const pairWith = input.from ?? input.via;
    if (!pairWith) throw new Error("A sending coworker is required");
    if (pairWith.id === input.to.id) throw new Error("A coworker cannot message itself");
    if (input.to.status !== "active") throw new Error(`${input.to.name} is paused`);

    // A coworker answering a request must not message the one who asked: its
    // reply already goes back there, and messaging would start a ping-pong.
    const answering = input.originTaskId ? this.obligation(input.originTaskId) : null;
    if (answering && [answering.replyToCoworkerId, answering.fromCoworkerId].includes(input.to.id)) {
      throw new Error(
        `You are answering ${input.to.name}'s request. Do not message ${input.to.name}; just reply here and your answer is sent back to them automatically.`,
      );
    }

    const callerDepth = input.originTaskId
      ? (database.getPeerTask(input.originTaskId)?.depth ?? 0)
      : 0;
    const depth = callerDepth + 1;
    if (depth > maxPeerDepth) {
      throw new Error(
        `Delegation depth limit (${maxPeerDepth}) reached; answer with what you have instead of asking another coworker`,
      );
    }
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    if (database.countRecentPeerRequests(pairWith.id, input.to.id, since) >= peerRequestsPerHour) {
      throw new Error(
        `Too many messages between ${pairWith.name} and ${input.to.name} in the last hour`,
      );
    }

    const senderLabel = input.from
      ? input.from.name
      : `the user (writing in ${pairWith.name}'s chat)`;
    const title = content.split("\n")[0]!.trim().slice(0, 80) || "Message";
    const taskId = randomUUID();
    const conversationId = database.transaction(() => {
      // The work happens in the target's own visible conversation, so the user
      // can follow it there; the requester only gets the outcome. One standing
      // conversation per requester keeps the history together and gives the
      // target the earlier requests as context.
      const conversation = database.findOrCreateDirectConversation(
        `delegated:${pairWith.id}:${input.to.id}`,
        { coworkerId: input.to.id, title: `From ${pairWith.name}` },
      );
      const message = database.addMessage({
        conversationId: conversation.id,
        coworkerId: input.from?.id ?? null,
        authorName: input.from?.name ?? "You",
        taskId: null,
        role: "user",
        // The chat replays as one voice, so say who is asking.
        content: input.from ? `${coworkerRequestPrefix(input.from.name)}${content}` : content,
      });
      database.createTask(
        {
          coworkerId: input.to.id,
          title,
          input: `Message from ${senderLabel}:\n\n${content}`,
          source: "manual",
          runId: randomUUID(),
          threadId: conversation.id,
          sourceMessageId: message.id,
          persistUserMessage: false,
        },
        taskId,
      );
      database.createPeerTask({
        taskId,
        kind: "request",
        fromCoworkerId: input.from?.id ?? null,
        toCoworkerId: input.to.id,
        originThreadId: input.originThreadId,
        replyToCoworkerId: input.expectReply ? pairWith.id : null,
        originTaskId: input.originTaskId ?? null,
        depth,
      });
      database.addActivity({
        coworkerId: input.to.id,
        taskId,
        type: "peer.message",
        summary: `${input.from?.name ?? "You"} messaged ${input.to.name}`,
        metadata: { from: input.from?.id ?? null, via: pairWith.id, depth },
      });
      return conversation.id;
    });
    this.options.emit({ type: "entity.changed", entity: "conversations", id: conversationId });
    this.options.emit({ type: "entity.changed", entity: "tasks", id: taskId });
    this.options.emit({ type: "entity.changed", entity: "activity" });
    this.options.enqueue(input.to.id);
    return { taskId, conversationId, depth };
  }

  /** Read-only digest of recent work, for a coworker reporting to the user. */
  activity(input: { excludeCoworkerId?: string; coworkerId?: string; sinceHours: number }) {
    const database = this.options.database;
    const cutoff = new Date(Date.now() - input.sinceHours * 60 * 60 * 1000).toISOString();
    const clip = (value: string | null, length: number) =>
      value && value.length > length ? `${value.slice(0, length - 1)}…` : value;
    const coworkers = database
      .listCoworkers()
      .filter((coworker) =>
        input.coworkerId
          ? coworker.id === input.coworkerId
          : coworker.id !== input.excludeCoworkerId,
      );
    return {
      sinceHours: input.sinceHours,
      coworkers: coworkers.map((coworker) => {
        const recent = database
          .listTasks(coworker.id, 200)
          .filter((task) => task.createdAt >= cutoff);
        const counts: Record<string, number> = {};
        for (const task of recent) counts[task.status] = (counts[task.status] ?? 0) + 1;
        return {
          id: coworker.id,
          name: coworker.name,
          role: coworker.role,
          status: coworker.status,
          runtimeStatus: coworker.runtimeStatus,
          tasksByStatus: counts,
          recentTasks: recent.slice(0, 5).map((task) => ({
            title: clip(task.title, 120),
            status: task.status,
            at: task.createdAt,
            result: clip(task.result, 300),
            error: clip(task.error, 200),
          })),
        };
      }),
    };
  }

  /** Posts the answer to the origin thread and, if asked, wakes the sender. */
  handleTaskCompleted(task: Task): void {
    this.deliver(task, task.result?.trim() || "Completed", false);
  }

  handleTaskFailed(task: Task, error: string): void {
    this.deliver(task, `Could not finish the request: ${error}`, true);
  }

  /** Delivers whatever outcome a finished task has; no-op while it is still active. */
  handleTaskSettled(task: Task): void {
    if (task.status === "COMPLETED") this.handleTaskCompleted(task);
    else if (task.status === "FAILED") this.handleTaskFailed(task, task.error ?? "unknown error");
    else if (task.status === "CANCELLED") {
      this.deliver(task, "The request was cancelled before it finished.", true);
    }
  }

  /** Delivers answers whose hook was missed, e.g. the app quit mid-completion. */
  recover(): void {
    const database = this.options.database;
    for (const peer of database.listUndeliveredPeerTasks()) {
      this.handleTaskSettled(database.getTask(peer.taskId));
    }
  }

  /**
   * The request a task's output answers. A request answers itself. A follow-up
   * continues the sender's task, so it answers whatever that task was answering:
   * when B consults C while handling A's request, B's follow-up reaches A.
   */
  private obligation(taskId: string): PeerTask | null {
    const database = this.options.database;
    const seen = new Set<string>();
    let current: string | null = taskId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const peer = database.getPeerTask(current);
      if (!peer) return null;
      if (peer.kind === "request") return peer;
      current = peer.originTaskId;
    }
    return null;
  }

  private deliver(task: Task, text: string, failed: boolean): void {
    const database = this.options.database;
    try {
      if (!database.getPeerTask(task.id)) return;
      const author = database.getCoworker(task.coworkerId);
      let wake: { coworkerId: string; taskId: string; threadId: string } | null = null;
      // Claim and write together: if delivery fails it rolls back and recovery retries.
      database.transaction(() => {
        if (!database.claimPeerTaskDelivery(task.id)) return;
        const request = this.obligation(task.id);
        // Work the user started already shows in its own thread.
        if (!request?.replyToCoworkerId) return;
        const requester = database
          .listCoworkers()
          .find((item) => item.id === request.replyToCoworkerId);
        if (!requester) return;
        const requestTask = database.getTask(request.taskId);
        const workConversation = database.getConversation(requestTask.threadId);
        const label = failed ? "Problem" : "Reply";
        const input = buildFollowUpInput({
          author: author.name,
          requestedByUser: request.fromCoworkerId === null,
          asked: requestedText(database, requestTask),
          result: text,
          failed,
          workConversationTitle: workConversation.title,
        });
        const followUpId = randomUUID();
        database.createTask(
          {
            coworkerId: requester.id,
            title: `${label} from ${author.name}`,
            input,
            source: "manual",
            runId: randomUUID(),
            threadId: request.originThreadId,
            persistUserMessage: false,
          },
          followUpId,
        );
        database.createPeerTask({
          taskId: followUpId,
          kind: "reply",
          fromCoworkerId: author.id,
          toCoworkerId: requester.id,
          originThreadId: request.originThreadId,
          replyToCoworkerId: null,
          originTaskId: request.originTaskId,
          depth: Math.max(0, request.depth - 1),
        });
        wake = { coworkerId: requester.id, taskId: followUpId, threadId: request.originThreadId };
      });
      const woken = wake as { coworkerId: string; taskId: string; threadId: string } | null;
      if (woken) {
        this.options.emit({ type: "entity.changed", entity: "conversations", id: woken.threadId });
        this.options.emit({ type: "entity.changed", entity: "tasks", id: woken.taskId });
        this.options.emit({ type: "entity.changed", entity: "activity" });
        this.options.enqueue(woken.coworkerId);
      }
    } catch (error) {
      this.options.onError?.("peer-messaging", error);
    }
  }
}

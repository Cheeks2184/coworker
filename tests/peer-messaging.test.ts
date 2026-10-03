import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeerMessaging, maxPeerDepth, peerRequestsPerHour } from "@main/app/peer-messaging";
import { CoworkerDatabase } from "@main/db/database";
import { ToolGateway } from "@main/tools/tool-gateway";
import type { DesktopEvent } from "@shared/contracts";

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((p) => rm(p, { force: true, recursive: true })));
});

const credentials = {
  async set() {},
  async get() {
    return null;
  },
  async has() {
    return false;
  },
  async delete() {},
};

const peerTools = ["coworkers.list", "coworkers.send_message", "coworkers.activity"];

async function setup() {
  // Throwaway database in a temp dir; never a real profile.
  const root = await mkdtemp(join(tmpdir(), "coworker-peer-"));
  temporaryPaths.push(root);
  const database = new CoworkerDatabase(join(root, "coworker.db"));
  const make = (name: string, enabledTools: string[] = peerTools) =>
    database.createCoworker(
      {
        name,
        role: `${name} role`,
        systemPrompt: "Help.",
        modelProvider: "demo",
        modelName: "faux-1",
        enabledTools,
      },
      join(root, name.toLowerCase()),
    );
  const enqueued: string[] = [];
  const events: DesktopEvent[] = [];
  const errors: unknown[] = [];
  const peers = new PeerMessaging({
    database,
    enqueue: (id) => enqueued.push(id),
    emit: (event) => events.push(event),
    onError: (_scope, error) => errors.push(error),
  });
  const gateway = new ToolGateway(database, credentials, join(root, "outbox"), { peers });
  return { root, database, make, peers, gateway, enqueued, events, errors };
}

describe("peer messaging", () => {
  it("runs requests in one standing, visible conversation of the target per requester", async () => {
    const { database, make, peers, enqueued } = await setup();
    try {
      const ava = make("Ava");
      const bea = make("Bea");
      const origin = database.listConversations(ava.id)[0]!;
      const sent = peers.send({
        from: ava,
        to: bea,
        content: "Draft the memo.",
        originThreadId: origin.id,
        expectReply: true,
      });
      expect(enqueued).toEqual([bea.id]);
      const task = database.getTask(sent.taskId);
      expect(task).toMatchObject({ coworkerId: bea.id, threadId: sent.conversationId });
      expect(task.input).toContain("Message from Ava");
      expect(database.getPeerTask(sent.taskId)).toMatchObject({
        kind: "request",
        depth: 1,
        replyToCoworkerId: ava.id,
        originThreadId: origin.id,
      });
      // Bea's own direct conversation, listed in her chat history; not Ava's.
      const work = database.getConversation(sent.conversationId);
      expect(work).toMatchObject({ kind: "direct", coworkerId: bea.id, title: "From Ava" });
      expect(database.listConversations(bea.id).map((c) => c.id)).toContain(work.id);
      expect(database.listConversations(ava.id).map((c) => c.id)).not.toContain(work.id);
      expect(database.listConversationMessages(work.id)).toMatchObject([
        { role: "user", authorName: "Ava", content: "From Ava: Draft the memo." },
      ]);
      // Later requests from Ava, including the user's tags in Ava's chat, continue
      // the same conversation, so Bea sees the earlier ones as context.
      const again = peers.send({ from: ava, to: bea, content: "Make it shorter", originThreadId: origin.id, expectReply: false });
      const tagged = peers.send({ from: null, via: ava, to: bea, content: "Thanks!", originThreadId: origin.id, expectReply: false });
      expect(again.conversationId).toBe(work.id);
      expect(tagged.conversationId).toBe(work.id);
      expect(database.getConversation(work.id).title).toBe("From Ava");
      expect(database.listConversationMessages(work.id).map((m) => m.content)).toEqual([
        "From Ava: Draft the memo.",
        "From Ava: Make it shorter",
        "Thanks!",
      ]);
      // A different requester gets a separate conversation.
      const cy = make("Cy");
      const fromCy = peers.send({ from: cy, to: bea, content: "Hi", originThreadId: database.listConversations(cy.id)[0]!.id, expectReply: false });
      expect(fromCy.conversationId).not.toBe(work.id);
      // Archived conversations come back when new work arrives.
      database.setConversationArchived(work.id, true);
      peers.send({ from: ava, to: bea, content: "One more", originThreadId: origin.id, expectReply: false });
      expect(database.getConversation(work.id).archivedAt).toBeNull();
    } finally {
      database.close();
    }
  });

  it("reports back to the sender without pasting the work into its chat", async () => {
    const { database, make, peers, enqueued } = await setup();
    try {
      const ava = make("Ava");
      const bea = make("Bea");
      const origin = database.listConversations(ava.id)[0]!;
      const sent = peers.send({
        from: ava,
        to: bea,
        content: "Summarize Q3.",
        originThreadId: origin.id,
        expectReply: true,
      });
      enqueued.length = 0;
      database.setTaskStatus(sent.taskId, "COMPLETED", { result: "Q3 grew 12%." });
      const done = database.getTask(sent.taskId);
      peers.handleTaskCompleted(done);
      peers.handleTaskCompleted(done); // duplicate delivery is ignored

      expect(database.listConversationMessages(origin.id)).toEqual([]);
      const followUps = database.listTasks(ava.id).filter((t) => database.getPeerTask(t.id)?.kind === "reply");
      expect(followUps).toHaveLength(1);
      expect(followUps[0]).toMatchObject({ threadId: origin.id, title: "Reply from Bea" });
      expect(followUps[0]!.input).toContain("Q3 grew 12%.");
      const input = followUps[0]!.input;
      // Framed as an automatic update about Bea's work, quoting the request and her reply.
      expect(input).toMatch(/^\[Automatic update about a coworker's work\. This is not a message from the user\.\]/);
      expect(input).toContain('You earlier asked Bea: "Summarize Q3."');
      expect(input).toContain("<<<\nQ3 grew 12%.\n>>>");
      expect(input).toContain("Do not answer the question yourself");
      expect(input).toContain('Bea\'s full work is in their conversation "From Ava"');
      expect(enqueued).toEqual([ava.id]);
    } finally {
      database.close();
    }
  });

  it("reports failures back instead of leaving the sender waiting", async () => {
    const { database, make, peers } = await setup();
    try {
      const ava = make("Ava");
      const bea = make("Bea");
      const origin = database.listConversations(ava.id)[0]!;
      const sent = peers.send({ from: ava, to: bea, content: "Do it", originThreadId: origin.id, expectReply: true });
      database.setTaskStatus(sent.taskId, "FAILED", { error: "model offline" });
      peers.handleTaskFailed(database.getTask(sent.taskId), "model offline");
      const followUp = database
        .listTasks(ava.id)
        .find((t) => database.getPeerTask(t.id)?.kind === "reply");
      expect(followUp).toMatchObject({ title: "Problem from Bea" });
      expect(followUp?.input).toContain("model offline");
    } finally {
      database.close();
    }
  });

  it("has the chat's coworker report back on a coworker the user tagged", async () => {
    const { database, make, peers, enqueued } = await setup();
    try {
      const ava = make("Ava");
      const bea = make("Bea");
      const origin = database.listConversations(ava.id)[0]!;
      const sent = peers.send({ from: null, via: ava, to: bea, content: "Hi Bea", originThreadId: origin.id, expectReply: true });
      expect(database.getTask(sent.taskId).input).toContain("the user");
      expect(database.getConversation(sent.conversationId).title).toBe("From Ava");
      expect(database.listConversationMessages(sent.conversationId)).toMatchObject([
        { role: "user", authorName: "You", content: "Hi Bea" },
      ]);
      enqueued.length = 0;
      database.setTaskStatus(sent.taskId, "COMPLETED", { result: "Hello!" });
      peers.handleTaskCompleted(database.getTask(sent.taskId));
      expect(enqueued).toEqual([ava.id]);
      const followUp = database.listTasks(ava.id).find((t) => t.title === "Reply from Bea")!;
      expect(followUp.threadId).toBe(origin.id);
      expect(followUp.input).toContain('The user earlier asked Bea: "Hi Bea"');
      expect(followUp.input).toContain("in the third person");
      expect(database.listConversationMessages(origin.id)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("stays silent when no reply was requested", async () => {
    const { database, make, peers, enqueued } = await setup();
    try {
      const ava = make("Ava");
      const bea = make("Bea");
      const origin = database.listConversations(ava.id)[0]!;
      const sent = peers.send({ from: ava, to: bea, content: "FYI", originThreadId: origin.id, expectReply: false });
      enqueued.length = 0;
      database.setTaskStatus(sent.taskId, "COMPLETED", { result: "Noted." });
      peers.handleTaskCompleted(database.getTask(sent.taskId));
      expect(enqueued).toEqual([]);
      expect(database.getPeerTask(sent.taskId)?.deliveredAt).not.toBeNull();
    } finally {
      database.close();
    }
  });

  it("rejects self, paused, unknown, empty and oversized messages", async () => {
    const { database, make, peers } = await setup();
    try {
      const ava = make("Ava");
      const bea = make("Bea");
      const paused = database.updateCoworker(make("Cy").id, { status: "paused" });
      const origin = database.listConversations(ava.id)[0]!.id;
      const base = { from: ava, originThreadId: origin, expectReply: true };
      expect(() => peers.send({ ...base, to: ava, content: "x" })).toThrow(/itself/);
      expect(() => peers.send({ ...base, to: paused, content: "x" })).toThrow(/paused/);
      expect(() => peers.send({ ...base, to: bea, content: "  " })).toThrow(/required/);
      expect(() => peers.send({ ...base, to: bea, content: "x".repeat(8_001) })).toThrow(/limited/);
      expect(() => peers.resolveTarget("Nobody", ava.id)).toThrow(/No coworker/);
      expect(peers.resolveTarget("bea", ava.id).id).toBe(bea.id);
      expect(() => peers.resolveTarget("Ava", ava.id)).toThrow(/No coworker/);
    } finally {
      database.close();
    }
  });

  it("refuses to message the coworker whose request is being answered", async () => {
    const { database, make, peers } = await setup();
    try {
      const ava = make("Ava");
      const bea = make("Bea");
      const cy = make("Cy");
      // The user tags Ava from Bea's chat; Ava must not bounce a message back to Bea.
      const fromUser = peers.send({ from: null, via: bea, to: ava, content: "hey", originThreadId: database.listConversations(bea.id)[0]!.id, expectReply: true });
      const avaThread = database.getTask(fromUser.taskId).threadId;
      expect(() =>
        peers.send({ from: ava, to: bea, content: "hey", originThreadId: avaThread, originTaskId: fromUser.taskId, expectReply: true }),
      ).toThrow(/answering Bea's request/);
      // Bea answering a request from Ava must not message Ava either.
      const toBea = peers.send({ from: ava, to: bea, content: "numbers?", originThreadId: database.listConversations(ava.id)[0]!.id, expectReply: true });
      const beaThread = database.getTask(toBea.taskId).threadId;
      expect(() =>
        peers.send({ from: bea, to: ava, content: "thanks!", originThreadId: beaThread, originTaskId: toBea.taskId, expectReply: true }),
      ).toThrow(/answering Ava's request/);
      // Asking a third coworker while answering is still allowed.
      expect(() =>
        peers.send({ from: bea, to: cy, content: "raw data?", originThreadId: beaThread, originTaskId: toBea.taskId, expectReply: true }),
      ).not.toThrow();
      // So is a follow-up message from the primary's own chat task after a reply.
      const chatTask = database.createTask({ coworkerId: ava.id, title: "Plan", input: "Plan" });
      expect(() =>
        peers.send({ from: ava, to: bea, content: "one more thing", originThreadId: chatTask.threadId, originTaskId: chatTask.id, expectReply: true }),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("caps delegation depth and per-pair volume", async () => {
    const { database, make, peers } = await setup();
    try {
      const a = make("Ava");
      const b = make("Bea");
      const c = make("Cy");
      const d = make("Dee");
      const e = make("Eve");
      const originOf = (id: string) => database.listConversations(id)[0]!.id;
      // a -> b -> c -> d -> (refused)
      let sent = peers.send({ from: a, to: b, content: "1", originThreadId: originOf(a.id), expectReply: true });
      sent = peers.send({ from: b, to: c, content: "2", originThreadId: originOf(b.id), originTaskId: sent.taskId, expectReply: true });
      sent = peers.send({ from: c, to: d, content: "3", originThreadId: originOf(c.id), originTaskId: sent.taskId, expectReply: true });
      expect(sent.depth).toBe(maxPeerDepth);
      expect(() =>
        peers.send({ from: d, to: e, content: "4", originThreadId: originOf(d.id), originTaskId: sent.taskId, expectReply: true }),
      ).toThrow(/depth limit/);

      for (let i = 0; i < peerRequestsPerHour; i += 1) {
        peers.send({ from: a, to: e, content: `m${i}`, originThreadId: originOf(a.id), expectReply: false });
      }
      expect(() =>
        peers.send({ from: e, to: a, content: "one too many", originThreadId: originOf(e.id), expectReply: false }),
      ).toThrow(/Too many/);
    } finally {
      database.close();
    }
  });

  it("lets one task delegate sequentially without hitting the nesting cap", async () => {
    const { database, make, peers } = await setup();
    try {
      const ava = make("Ava");
      const team = [make("Bea"), make("Cy"), make("Dee"), make("Eve"), make("Fay")];
      const origin = database.listConversations(ava.id)[0]!.id;
      // Ava's own chat task (depth 0) asks each coworker in turn, continuing from each reply.
      let callerTaskId = database.createTask({ coworkerId: ava.id, title: "Plan", input: "Plan", threadId: origin }).id;
      for (const member of team) {
        const sent = peers.send({ from: ava, to: member, content: "Your part?", originThreadId: origin, originTaskId: callerTaskId, expectReply: true });
        expect(sent.depth).toBe(1);
        database.setTaskStatus(sent.taskId, "COMPLETED", { result: `${member.name} done` });
        peers.handleTaskCompleted(database.getTask(sent.taskId));
        const followUp = database.listTasks(ava.id).find((t) => t.title === `Reply from ${member.name}`)!;
        expect(database.getPeerTask(followUp.id)).toMatchObject({ kind: "reply", depth: 0 });
        callerTaskId = followUp.id;
      }
    } finally {
      database.close();
    }
  });

  it("forwards a coworker's final answer after it consulted someone else", async () => {
    const { database, make, peers, enqueued } = await setup();
    try {
      const ava = make("Ava");
      const bea = make("Bea");
      const cy = make("Cy");
      const origin = database.listConversations(ava.id)[0]!.id;
      const chatTask = database.createTask({ coworkerId: ava.id, title: "Q", input: "Q", threadId: origin });
      // Ava asks Bea; while answering, Bea asks Cy.
      const toBea = peers.send({ from: ava, to: bea, content: "Numbers?", originThreadId: origin, originTaskId: chatTask.id, expectReply: true });
      const beaThread = database.getTask(toBea.taskId).threadId;
      const toCy = peers.send({ from: bea, to: cy, content: "Raw data?", originThreadId: beaThread, originTaskId: toBea.taskId, expectReply: true });
      expect(toCy.depth).toBe(2);

      // Bea's first turn (an acknowledgement) reaches Ava right away.
      database.setTaskStatus(toBea.taskId, "COMPLETED", { result: "Asked Cy; full answer to follow." });
      peers.handleTaskCompleted(database.getTask(toBea.taskId));
      // Cy answers Bea inside the Ava-Bea thread and wakes Bea.
      database.setTaskStatus(toCy.taskId, "COMPLETED", { result: "Raw: 42" });
      peers.handleTaskCompleted(database.getTask(toCy.taskId));
      const beaFollowUp = database.listTasks(bea.id).find((t) => t.title === "Reply from Cy")!;
      expect(beaFollowUp.threadId).toBe(beaThread);
      expect(database.getPeerTask(beaFollowUp.id)).toMatchObject({ depth: 1, originTaskId: toBea.taskId });

      enqueued.length = 0;
      database.setTaskStatus(beaFollowUp.id, "COMPLETED", { result: "Final: 42 units" });
      peers.handleTaskCompleted(database.getTask(beaFollowUp.id));

      // Ava hears from Bea twice: the acknowledgement, then the final answer.
      const avaFollowUps = database
        .listTasks(ava.id)
        .filter((t) => t.title === "Reply from Bea")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      expect(avaFollowUps).toHaveLength(2);
      expect(avaFollowUps[0]!.input).toContain("Asked Cy; full answer to follow.");
      expect(avaFollowUps[1]!.input).toContain("Final: 42 units");
      expect(avaFollowUps.every((t) => t.threadId === origin)).toBe(true);
      expect(avaFollowUps.every((t) => database.getPeerTask(t.id)?.depth === 0)).toBe(true);
      expect(enqueued).toEqual([ava.id]);
    } finally {
      database.close();
    }
  });

  it("keeps a delivery pending when writing it fails, so recovery can retry", async () => {
    const { database, make, peers, errors } = await setup();
    try {
      const ava = make("Ava");
      const bea = make("Bea");
      const origin = database.listConversations(ava.id)[0]!.id;
      const sent = peers.send({ from: ava, to: bea, content: "x", originThreadId: origin, expectReply: true });
      database.setTaskStatus(sent.taskId, "COMPLETED", { result: "done" });
      const spy = vi.spyOn(database, "createTask").mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      peers.handleTaskCompleted(database.getTask(sent.taskId));
      spy.mockRestore();
      expect(errors).toHaveLength(1);
      expect(database.getPeerTask(sent.taskId)?.deliveredAt).toBeNull();
      const followUps = () => database.listTasks(ava.id).filter((t) => t.title === "Reply from Bea");
      expect(followUps()).toHaveLength(0);

      peers.recover();
      expect(database.getPeerTask(sent.taskId)?.deliveredAt).not.toBeNull();
      expect(followUps()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("summarizes recent activity without including the caller", async () => {
    const { database, make, peers } = await setup();
    try {
      const ava = make("Ava");
      const bea = make("Bea");
      const task = database.createTask({ coworkerId: bea.id, title: "Reconcile invoices", input: "go" });
      database.setTaskStatus(task.id, "COMPLETED", { result: "All matched." });
      const summary = peers.activity({ excludeCoworkerId: ava.id, sinceHours: 24 });
      expect(summary.coworkers.map((c) => c.name)).toEqual(["Bea"]);
      expect(summary.coworkers[0]).toMatchObject({ tasksByStatus: { COMPLETED: 1 } });
      expect(summary.coworkers[0]!.recentTasks[0]).toMatchObject({ title: "Reconcile invoices", result: "All matched." });
    } finally {
      database.close();
    }
  });
});

describe("coworkers.* tools through the gateway", () => {
  it("runs automatically for an enabled coworker and records the call", async () => {
    const { database, make, gateway, enqueued } = await setup();
    try {
      const ava = make("Ava");
      const bea = make("Bea");
      const task = database.createTask({ coworkerId: ava.id, title: "Ask Bea", input: "Ask Bea for numbers" });
      const listed = await gateway.request({ task, coworker: ava, toolCallId: "t1", toolName: "coworkers.list", arguments: {} });
      expect(listed).toMatchObject({ kind: "completed" });
      expect(JSON.stringify(listed)).toContain("Bea");
      expect(JSON.stringify(listed)).not.toContain('"name":"Ava"');

      const sent = await gateway.request({
        task,
        coworker: ava,
        toolCallId: "t2",
        toolName: "coworkers.send_message",
        arguments: { coworker: "Bea", message: "Send the Q3 numbers" },
      });
      expect(sent).toMatchObject({ kind: "completed" });
      expect(enqueued).toEqual([bea.id]);
      const peerTask = database.listTasks(bea.id).find((t) => database.getPeerTask(t.id));
      expect(database.getPeerTask(peerTask!.id)).toMatchObject({
        replyToCoworkerId: ava.id,
        originThreadId: task.threadId,
      });
    } finally {
      database.close();
    }
  });

  it("denies the tools to a coworker that was not granted them", async () => {
    const { database, make, gateway } = await setup();
    try {
      const ava = make("Ava", []);
      make("Bea");
      const task = database.createTask({ coworkerId: ava.id, title: "x", input: "x" });
      const result = await gateway.request({
        task,
        coworker: ava,
        toolCallId: "t3",
        toolName: "coworkers.send_message",
        arguments: { coworker: "Bea", message: "hi" },
      });
      expect(result.kind).toBe("denied");
    } finally {
      database.close();
    }
  });
});

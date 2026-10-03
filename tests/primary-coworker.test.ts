import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { CoworkerDatabase } from "@main/db/database";
import { bundledPrimaryCoordinatorSkill, bundledCoworkerMessagingSkill, parseSkillMarkdown } from "@main/integrations/skills";
import { defaultEnabledBundledSkillNames, toolNamesForSkills } from "@shared/skill-capabilities";

const temporaryPaths: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const credentials = () => {
  const values = new Map<string, string>();
  return {
    async set(key: string, value: string) { values.set(key, value); },
    async get(key: string) { return values.get(key) ?? null; },
    async has(key: string) { return values.has(key); },
    async delete(key: string) { values.delete(key); },
  };
};

async function setup() {
  // Throwaway data directory; never a real profile.
  const root = await mkdtemp(join(tmpdir(), "coworker-primary-"));
  temporaryPaths.push(root);
  const database = new CoworkerDatabase(join(root, "coworker.db"));
  const service = new DesktopAppService({ dataPath: root, database, credentials: credentials() });
  (service as unknown as { seedSkills(): void }).seedSkills();
  const enqueue = vi.spyOn(service.runtime, "enqueueTask").mockImplementation(() => undefined);
  const make = (name: string) =>
    database.createCoworker(
      { name, role: `${name} specialist`, systemPrompt: `You are ${name}.`, modelProvider: "demo", modelName: "faux-1", enabledTools: [] },
      join(root, name.toLowerCase()),
    );
  return { root, database, service, enqueue, make };
}

describe("bundled coordination skills", () => {
  it("are narrowly routed and grant only the coworker tools", () => {
    expect(parseSkillMarkdown(bundledPrimaryCoordinatorSkill.content)).toMatchObject({
      name: "primary-coordinator",
      description: expect.stringContaining("Do not use for work within your own role"),
    });
    expect(parseSkillMarkdown(bundledCoworkerMessagingSkill.content)).toMatchObject({
      name: "coworker-messaging",
      description: expect.stringContaining("Do not use for work you can complete yourself"),
    });
    expect(toolNamesForSkills([{ name: "coworker-messaging" }]).sort()).toEqual(["coworkers.list", "coworkers.send_message"]);
    expect(toolNamesForSkills([{ name: "primary-coordinator" }])).toContain("coworkers.activity");
    // Everyone can message peers; only the primary gets the coordinator.
    expect(defaultEnabledBundledSkillNames.has("coworker-messaging")).toBe(true);
    expect(defaultEnabledBundledSkillNames.has("primary-coordinator")).toBe(false);
  });
});

describe("primary coworker", () => {
  it("moves the coordinator skill and the daily digest with the primary role", async () => {
    const { database, service, make } = await setup();
    try {
      const ava = make("Ava");
      const bea = make("Bea");
      const skillId = database.getSkillByName("primary-coordinator")!.id;
      // Everyone starts with peer messaging; role changes must not disturb it.
      const messagingId = database.getSkillByName("coworker-messaging")!.id;
      database.setCoworkerSkills(ava.id, [messagingId]);
      database.setCoworkerSkills(bea.id, [messagingId]);
      const digests = (id: string) =>
        database.listSchedules().filter((s) => s.coworkerId === id && s.name === "Team digest");

      await service.updateCoworker(ava.id, { isPrimary: true });
      expect(database.getCoworker(ava.id).enabledSkillIds).toContain(skillId);
      expect(digests(ava.id)).toHaveLength(1);
      expect(digests(ava.id)[0]).toMatchObject({
        enabled: true,
        cronExpression: "0 9 * * *",
        conversationId: null,
      });
      expect(database.getCoworker(bea.id).enabledSkillIds).not.toContain(skillId);

      await service.updateCoworker(bea.id, { isPrimary: true });
      expect(database.getCoworker(ava.id)).toMatchObject({ isPrimary: false });
      expect(database.getCoworker(ava.id).enabledSkillIds).not.toContain(skillId);
      expect(digests(ava.id)[0]!.enabled).toBe(false);
      expect(database.getCoworker(bea.id).enabledSkillIds).toContain(skillId);
      expect(digests(bea.id)).toHaveLength(1);

      // Re-promoting reuses the existing schedule instead of duplicating it.
      await service.updateCoworker(ava.id, { isPrimary: true });
      expect(digests(ava.id)).toHaveLength(1);
      expect(digests(ava.id)[0]!.enabled).toBe(true);
      expect(digests(bea.id)[0]!.enabled).toBe(false);
      expect(database.listCoworkers().filter((c) => c.isPrimary)).toHaveLength(1);
      for (const id of [ava.id, bea.id]) {
        expect(database.getCoworker(id).enabledSkillIds).toContain(messagingId);
      }
      await service.updateCoworker(ava.id, { isPrimary: false });
      expect(database.getCoworker(ava.id).enabledSkillIds).toEqual([messagingId]);
    } finally {
      await service.runtime.stopAll();
      database.close();
    }
  });
});

describe("snapshot peer links", () => {
  it("marks delegated work with its origin thread and follow-ups with whose work they report", async () => {
    const { database, service, make } = await setup();
    try {
      const ava = make("Ava");
      const bea = make("Bea");
      const origin = database.listConversations(ava.id)[0]!.id;
      const sent = service.peers.send({ from: ava, to: bea, content: "Draft it", originThreadId: origin, expectReply: true });
      const delegated = () => service.snapshot().tasks.find((t) => t.id === sent.taskId)!;
      expect(delegated()).toMatchObject({ delegatedFromThreadId: origin, status: "QUEUED" });

      database.setTaskStatus(sent.taskId, "COMPLETED", { result: "Done" });
      service.peers.handleTaskCompleted(database.getTask(sent.taskId));
      const followUp = service.snapshot().tasks.find((t) => t.title === "Reply from Bea")!;
      expect(followUp).toMatchObject({ replyFromCoworkerId: bea.id, threadId: origin });
      expect(followUp.delegatedFromThreadId).toBeUndefined();
    } finally {
      await service.runtime.stopAll();
      database.close();
    }
  });
});

describe("team digest resilience", () => {
  it("still promotes when the default conversation was deleted", async () => {
    const { database, service, make } = await setup();
    try {
      const ava = make("Ava");
      database.deleteConversation(`coworker:${ava.id}`);
      await expect(service.updateCoworker(ava.id, { isPrimary: true })).resolves.toMatchObject({ isPrimary: true });
      const digest = database.listSchedules().find((s) => s.coworkerId === ava.id && s.name === "Team digest");
      expect(digest).toMatchObject({ enabled: true, conversationId: null });
      expect(() => (service as unknown as { syncPrimaryCoordinator(): void }).syncPrimaryCoordinator()).not.toThrow();
    } finally {
      await service.runtime.stopAll();
      database.close();
    }
  });
});

describe("peer reply recovery", () => {
  it("delivers answers that were never handed to the hook, including cancellations", async () => {
    const { database, service, make } = await setup();
    try {
      const ava = make("Ava");
      const bea = make("Bea");
      const cy = make("Cy");
      const origin = database.listConversations(ava.id)[0]!.id;
      const done = service.peers.send({ from: ava, to: bea, content: "one", originThreadId: origin, expectReply: true });
      const cancelled = service.peers.send({ from: ava, to: cy, content: "two", originThreadId: origin, expectReply: true });
      // Simulates quitting between the status change and the completion hook.
      database.setTaskStatus(done.taskId, "COMPLETED", { result: "Finished." });
      database.cancelTask(cancelled.taskId);

      service.peers.recover();
      service.peers.recover(); // idempotent

      const followUps = database.listTasks(ava.id).filter((t) => database.getPeerTask(t.id)?.kind === "reply");
      expect(followUps.map((t) => t.title).sort()).toEqual(["Problem from Cy", "Reply from Bea"]);
      expect(followUps.find((t) => t.title === "Reply from Bea")!.input).toContain("Finished.");
      expect(followUps.find((t) => t.title === "Problem from Cy")!.input).toContain("cancelled before it finished");
    } finally {
      await service.runtime.stopAll();
      database.close();
    }
  });
});

describe("tagging coworkers in a direct chat", () => {
  it("has the tagged coworker work in her own conversation and the chat's coworker report back", async () => {
    const { database, service, enqueue, make } = await setup();
    try {
      const ava = make("Ava");
      const bea = make("Bea");
      const chat = database.listConversations(ava.id)[0]!;
      const receipt = await service.sendConversationMessage({
        conversationId: chat.id,
        clientMessageId: "tag-1",
        content: "@Bea can you draft the memo?",
        mentionedCoworkerIds: [bea.id],
      });
      expect(receipt.message).toMatchObject({ id: "tag-1", conversationId: chat.id, authorName: "You" });
      expect(receipt.runs).toEqual([]);
      expect(enqueue.mock.calls.map((c) => c[0])).toEqual([bea.id]);
      expect(database.listTasks(ava.id)).toHaveLength(0);
      const beaTask = database.listTasks(bea.id)[0]!;
      expect(database.getPeerTask(beaTask.id)).toMatchObject({ fromCoworkerId: null, originThreadId: chat.id, replyToCoworkerId: ava.id });
      // Bea's work happens in a conversation listed in her own chat history.
      expect(database.listConversations(bea.id).map((c) => c.id)).toContain(beaTask.threadId);
      expect(database.getConversation(beaTask.threadId).title).toBe("From Ava");
      // In Bea's own conversation the leading "@Bea" is redundant, so it is dropped.
      expect(database.listConversationMessages(beaTask.threadId).map((m) => m.content)).toEqual([
        "can you draft the memo?",
      ]);

      // When Bea finishes, Ava gets the result to summarize here; nothing is pasted.
      enqueue.mockClear();
      database.setTaskStatus(beaTask.id, "COMPLETED", { result: "Draft attached." });
      service.peers.handleTaskCompleted(database.getTask(beaTask.id));
      expect(enqueue.mock.calls.map((c) => c[0])).toEqual([ava.id]);
      const report = database.listTasks(ava.id)[0]!;
      expect(report).toMatchObject({ title: "Reply from Bea", threadId: chat.id });
      // The chat is named after the user's message, not after the follow-up.
      expect(database.getConversation(chat.id).title).toBe("@Bea can you draft the memo?");
      expect(database.listConversationMessages(chat.id).map((m) => m.role)).toEqual(["user"]);
    } finally {
      await service.runtime.stopAll();
      database.close();
    }
  });

  it("rejects over-long tagged messages before storing anything", async () => {
    const { database, service, enqueue, make } = await setup();
    try {
      const ava = make("Ava");
      const bea = make("Bea");
      const chat = database.listConversations(ava.id)[0]!;
      await expect(
        service.sendConversationMessage({ conversationId: chat.id, clientMessageId: "long", content: `@Bea ${"x".repeat(8_001)}`, mentionedCoworkerIds: [bea.id] }),
      ).rejects.toThrow(/limited/);
      expect(database.listConversationMessages(chat.id)).toHaveLength(0);
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await service.runtime.stopAll();
      database.close();
    }
  });

  it("reports the real outcome when cancelling a task that already finished", async () => {
    const { database, service, make } = await setup();
    try {
      const ava = make("Ava");
      const bea = make("Bea");
      const origin = database.listConversations(ava.id)[0]!.id;
      const sent = service.peers.send({ from: ava, to: bea, content: "x", originThreadId: origin, expectReply: true });
      database.setTaskStatus(sent.taskId, "COMPLETED", { result: "All good." });
      vi.spyOn(service.runtime, "abort").mockResolvedValue(undefined as never);
      await service.cancelTask(sent.taskId);
      const followUps = database.listTasks(ava.id).filter((t) => database.getPeerTask(t.id)?.kind === "reply");
      expect(followUps.map((t) => t.title)).toEqual(["Reply from Bea"]);
      expect(followUps[0]!.input).toContain("All good.");
    } finally {
      await service.runtime.stopAll();
      database.close();
    }
  });

  it("also runs the chat's own coworker when it is tagged too", async () => {
    const { database, service, enqueue, make } = await setup();
    try {
      const ava = make("Ava");
      const bea = make("Bea");
      const chat = database.listConversations(ava.id)[0]!;
      const receipt = await service.sendConversationMessage({
        conversationId: chat.id,
        clientMessageId: "tag-2",
        content: "@Ava and @Bea please both look.",
        mentionedCoworkerIds: [ava.id, bea.id],
      });
      expect(receipt.runs).toHaveLength(1);
      expect(receipt.message.mentionedCoworkerIds.sort()).toEqual([ava.id, bea.id].sort());
      expect(enqueue.mock.calls.map((c) => c[0]).sort()).toEqual([ava.id, bea.id].sort());
      expect(database.listConversationMessages(chat.id).filter((m) => m.role === "user")).toHaveLength(1);

      // A retry with the same id is a no-op instead of an error or a duplicate.
      const retried = await service.sendConversationMessage({
        conversationId: chat.id,
        clientMessageId: "tag-2",
        content: "@Ava and @Bea please both look.",
        mentionedCoworkerIds: [ava.id, bea.id],
      });
      expect(retried.message.id).toBe("tag-2");
      expect(database.listTasks(bea.id)).toHaveLength(1);
      expect(database.listTasks(ava.id)).toHaveLength(1);
    } finally {
      await service.runtime.stopAll();
      database.close();
    }
  });

  it("refuses paused targets before writing anything", async () => {
    const { database, service, enqueue, make } = await setup();
    try {
      const ava = make("Ava");
      const bea = make("Bea");
      database.updateCoworker(bea.id, { status: "paused" });
      const chat = database.listConversations(ava.id)[0]!;
      await expect(
        service.sendConversationMessage({ conversationId: chat.id, clientMessageId: "tag-3", content: "@Bea hi", mentionedCoworkerIds: [bea.id] }),
      ).rejects.toThrow(/paused/);
      expect(database.listConversationMessages(chat.id)).toHaveLength(0);
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await service.runtime.stopAll();
      database.close();
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  buildFollowUpInput,
  coworkerRequestPrefix,
  extractFollowUpReply,
  stripCoworkerRequestPrefix,
} from "@shared/peer-follow-up";

describe("peer follow-up format", () => {
  const base = { author: "Sarah", requestedByUser: true, asked: "write 3 subject lines", failed: false, workConversationTitle: "From Ava" };

  it("round-trips the coworker's formatted reply for display", () => {
    const result = "Here are 3:\n\n1. **Checking in**\n2. **Follow-up question**\n3. **Still interested?**";
    const input = buildFollowUpInput({ ...base, result });
    expect(extractFollowUpReply(input)).toBe(result);
  });

  it("survives replies that contain the delimiters themselves", () => {
    const result = "Use this template:\n<<<\nHi there\n>>>\nThanks";
    expect(extractFollowUpReply(buildFollowUpInput({ ...base, result }))).toBe(result);
  });

  it("frames the update for the requester", () => {
    const input = buildFollowUpInput({ ...base, result: "Done" });
    expect(input).toMatch(/^\[Automatic update about a coworker's work/);
    expect(input).toContain('The user earlier asked Sarah: "write 3 subject lines"');
    expect(input).toContain("keep Markdown formatting");
    expect(input).toContain("full reply below your message");
  });

  it("returns null for ordinary task input", () => {
    expect(extractFollowUpReply("Draft the Q3 summary")).toBeNull();
  });

  it("strips the attribution on coworker requests, including the older bold form", () => {
    expect(stripCoworkerRequestPrefix(`${coworkerRequestPrefix("Ava")}hey`)).toBe("hey");
    expect(stripCoworkerRequestPrefix("**From Ava:** hey")).toBe("hey");
    expect(stripCoworkerRequestPrefix("hey there")).toBe("hey there");
  });
});

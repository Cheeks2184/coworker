/**
 * The follow-up a requester receives when another coworker finishes its work.
 * It arrives as the requester's next prompt, so it states plainly that it is
 * an automatic update and who the requester is talking to. The renderer reads
 * the quoted reply back out to show the coworker's original, formatted answer.
 */

/** Attribution stored on a request from a coworker, since a chat replays as one voice. */
export function coworkerRequestPrefix(name: string): string {
  return `From ${name}: `;
}

/** The request text without its attribution (also handles the older bold form). */
export function stripCoworkerRequestPrefix(content: string): string {
  return content.replace(/^(\*\*)?From [^:*\n]+:(\*\*)?\s*/, "");
}

const replyStart = "<<<";
const replyEnd = ">>>";

function clip(value: string, length: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

export function buildFollowUpInput(input: {
  author: string;
  requestedByUser: boolean;
  asked: string;
  result: string;
  failed: boolean;
  workConversationTitle: string;
}): string {
  const asker = input.requestedByUser ? "The user" : "You";
  const outcome = input.failed
    ? `${input.author} could not finish it. Their explanation:`
    : `${input.author}'s answer (${input.author} speaking about their own work and abilities):`;
  return [
    "[Automatic update about a coworker's work. This is not a message from the user.]",
    "",
    input.asked
      ? `${asker} earlier asked ${input.author}: "${clip(input.asked, 400)}"`
      : `${asker} earlier sent ${input.author} a request.`,
    outcome,
    replyStart,
    input.result,
    replyEnd,
    "",
    `Relay this to the user briefly, in the third person (for example "${input.author} says…"). ` +
      `The user also sees ${input.author}'s full reply below your message, so summarize instead of repeating it, ` +
      `and keep Markdown formatting (lists, line breaks) for anything you do quote. ` +
      `Do not answer the question yourself, do not describe your own abilities, and do not address ${input.author}. ` +
      `${input.author}'s full work is in their conversation "${input.workConversationTitle}", which the user can open.`,
  ].join("\n");
}

/** The coworker's original reply quoted in a follow-up input, or null. */
export function extractFollowUpReply(input: string): string | null {
  const start = input.indexOf(`\n${replyStart}\n`);
  const end = input.lastIndexOf(`\n${replyEnd}\n`);
  if (start < 0 || end <= start) return null;
  const reply = input.slice(start + replyStart.length + 2, end).trim();
  return reply || null;
}

import type { Approval } from "@shared/contracts";
import { describeCronExpression } from "@shared/schedule-frequency";
import { formatClockDateTime } from "@shared/time";
import { workspaceTextApproval } from "@shared/workspace-text-approval";

export function formatActionType(actionType: string): string {
  return actionType
    .split(".")
    .map((part) => part.replaceAll("_", " "))
    .join(" · ");
}

export function approvalPreviewRows(approval: Approval): Array<[string, string]> {
  const text = workspaceTextApproval(approval);
  if (text) return [["Change", text.title], [text.text ? "Proposed text" : "Text to remove", text.text || text.oldText || ""]];
  const payload = approval.proposedPayload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [
      ["Action", formatActionType(approval.actionType)],
      ["Risk", approval.riskLevel],
    ];
  }

  const record = payload as Record<string, unknown>;
  const rows: Array<[string, string]> = [];
  if (approval.actionType.startsWith("schedules.")) {
    if (typeof record.name === "string") rows.push(["Name", record.name]);
    if (typeof record.cronExpression === "string") {
      rows.push(["Runs", describeCronExpression(record.cronExpression)]);
    } else if (typeof record.runAt === "string") {
      rows.push(["Runs", `Once on ${formatClockDateTime(record.runAt)}`]);
    }
    const template = record.taskTemplate;
    if (template && typeof template === "object" && !Array.isArray(template)) {
      const title = (template as Record<string, unknown>).title;
      if (typeof title === "string") rows.push(["Task", title]);
    }
    if (rows.length > 0) return rows.slice(0, 3);
  }
  if (typeof record.subject === "string") rows.push(["Subject", record.subject]);
  if (typeof record.to === "string") rows.push(["Recipient", record.to]);
  if (Array.isArray(record.to)) {
    rows.push(["Recipient", record.to.filter((value) => typeof value === "string").join(", ")]);
  }
  if (Array.isArray(record.attachments)) {
    rows.push([
      "Files",
      `${record.attachments.length} attachment${record.attachments.length === 1 ? "" : "s"}`,
    ]);
  }

  if (rows.length === 0) {
    let added = 0;
    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        continue;
      }
      rows.push([
        key.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase()),
        String(value),
      ]);
      added += 1;
      if (added === 3) break;
    }
  }

  return rows.slice(0, 3);
}

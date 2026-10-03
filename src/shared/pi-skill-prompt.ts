export interface ModelSelectableSkill {
  name: string;
  description: string;
}

/** Pi's native skill listing; keep its wording and XML shape so skill selection behaves as in Pi. */
function formatNativeSkillListing(skills: ModelSelectableSkill[]): string {
  if (skills.length === 0) return "";
  return [
    "The following skills provide specialized instructions for specific tasks.",
    "Read the full skill file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
    ...skills.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(`skill://${skill.name}/SKILL.md`)}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function formatModelSelectableSkills(skills: ModelSelectableSkill[]): string {
  const nativePrompt = formatNativeSkillListing(skills);
  if (!nativePrompt) return "";
  return [
    nativePrompt,
    "In this app, load a skill:// location by calling skills.read with the skill name; do not use files.read for skill locations. Skills are instruction packages, not callable tools: never call a skill name as a tool. Use only the registered tool names and their declared argument schemas. The model decides whether a skill matches the current request from its description. Read a matching skill before acting, even for a simple request; a low-level tool does not replace the skill's instructions. Load only skills needed for the requested action, not skills that merely share the same subject matter. Use the optional path argument only for a packaged resource referenced by the loaded SKILL.md. Never claim to have used a skill unless skills.read succeeded during this request.",
  ].join("\n\n");
}

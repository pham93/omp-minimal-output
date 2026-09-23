import { Container } from "@oh-my-pi/pi-tui";
import { detailedRowLimit } from "../core/density.ts";
import { paintRow } from "../core/theme.ts";

export function skillPromptOf(message: unknown): { name: string; args: string; userInvoked: boolean } {
  const m = (message ?? {}) as Record<string, unknown>;
  const details = (m["details"] ?? {}) as Record<string, unknown>;
  const rawName = details["name"];
  const rawPath = details["path"];
  const chip = details["__queueChipText"];
  let name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : "";
  let args = "";
  const rawArgs = details["args"];
  if (typeof rawArgs === "string" && rawArgs.trim()) args = rawArgs.trim();
  else if (Array.isArray(rawArgs)) {
    const parts = rawArgs.map(String).filter((s) => s.trim());
    if (parts.length > 0) args = parts.join(" ");
  }
  if (typeof chip === "string" && chip.trim()) {
    const one = chip.replace(/\s+/g, " ").trim();
    const mm = one.match(/^\/skill:([^\s]+)\s*(.*)$/);
    if (mm) {
      if (!name) name = mm[1];
      if (!args && mm[2]) args = mm[2].trim();
    } else if (!args) args = one;
  }
  if (!name && typeof rawPath === "string") {
    const bits = rawPath.replace(/\\/g, "/").split("/").filter(Boolean);
    if (bits.length >= 2) name = bits[bits.length - 2];
    else if (bits.length === 1) name = bits[0].replace(/\.md$/i, "");
  }
  if (!name) name = "skill";
  args = args.replace(/\s+/g, " ").trim();
  if (args.length > 80) args = `${args.slice(0, 80)}…`;
  const attribution = m["attribution"];
  return { name, args, userInvoked: attribution === "user" };
}

export function skillPromptBody(message: unknown): string {
  const m = (message ?? {}) as Record<string, unknown>;
  const content = m["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const item = (content as Array<Record<string, unknown>>).find(
      (c) => c?.["type"] === "text" && typeof c["text"] === "string",
    );
    if (item) return item["text"] as string;
  }
  return "";
}

export function renderSkillPrompt(
  message: unknown,
  options: unknown,
  theme: unknown,
  isActive: () => boolean,
): Container {
  if (!isActive()) return new Container();
  const m = (message ?? {}) as Record<string, unknown>;
  if (m["display"] === false) return new Container();
  const opts = (options ?? {}) as Record<string, unknown>;
  const { name, args, userInvoked } = skillPromptOf(message);
  if (opts["expanded"] === true) {
    const body = skillPromptBody(message);
    if (!body) return new Container();
    const rows = body.split(/\r?\n/u);
    const maxRows = detailedRowLimit();
    const visible =
      rows.length <= maxRows
        ? rows
        : [...rows.slice(0, Math.max(0, maxRows - 1)), `… ${rows.length - maxRows + 1} more rows`];
    return paintRow(theme, { body: visible.join("\n") });
  }
  // No mark in the body: `paintRow` paints the configured indicator itself.
  const oneLiner = userInvoked && args ? `Skill ${name} ${args}` : `Skill ${name}`;
  return paintRow(theme, { body: oneLiner });
}

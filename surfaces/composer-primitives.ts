/**
 * Composer vocabulary and text primitives: the host status glyphs the docks
 * match against plus the ANSI-aware offset and width helpers shared by the
 * gauge, status, and frame layers.
 */
import { sliceByColumn, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

export const PROJECT_ICON_VARIANTS = [
  { host: "📁", replacement: "⌂" },
  { host: "\ud83d\udcc1", replacement: "⌂" },
  { host: "\uf115", replacement: "" },
  { host: "\uf07b", replacement: "" },
  { host: "\uf0e8", replacement: "" },
  { host: "\ud83c\udf33", replacement: "⌂" },
  { host: "[wt]", replacement: "~" },
  { host: "[D]", replacement: "~" },
  { host: "[T]", replacement: "~" },
] as const;
export const NERD_STATUS_ICON_VARIANTS = [
  { host: "\uec19", replacement: "󰚩" },
  { host: "\uf2d2", replacement: "" },
] as const;
export const PLAN_ICON_VARIANTS = ["🗺", "", "\uf2d2", "plan"] as const;
export const PLAN_PAUSE_SUFFIXES = [" \uf04c", " ⏸", " ||", " (paused)"] as const;
export const BUILD_STATUS_VARIANTS = {
  nerd: "󰣪 build",
  unicode: "🔨 build",
  ascii: "build",
} as const;
export const USAGE_ICON_VARIANTS = ["⏱", "\uf017", "time:"] as const;
export const CONTEXT_GAUGE_MAX_WIDTH = 24;
export const ANSI_SEQUENCE_RE = /^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\))/u;
export const STATUS_COLOR = {
  project: "statusLinePath",
  build: "statusLineModel",
  planActive: "accent",
  planPaused: "warning",
  working: "statusLineModel",
  gitClean: "statusLineGitClean",
  gitDirty: "statusLineGitDirty",
} as const;
export type StatusColor = (typeof STATUS_COLOR)[keyof typeof STATUS_COLOR];
export const GIT_DETAIL_VARIANTS = [
  { hostBranch: "⑂", branch: "⎇", modified: "Δ" },
  { hostBranch: "\uf126", branch: "\uf126", modified: "\uf044" },
  { hostBranch: "@", branch: "@", modified: "~" },
] as const;
export const CONTEXT_GAUGE_CAPS = [
  { left: "▶", right: "◀" },
  { left: "\ue0b0", right: "\ue0b2" },
] as const;
export const MODEL_ICON_VARIANTS = ["⬢", "󰚩"] as const;
export function rawOffsetForPlainIndex(content: string, target: number): number {
  let rawOffset = 0;
  let plainOffset = 0;
  while (rawOffset < content.length && plainOffset < target) {
    const sequence = ANSI_SEQUENCE_RE.exec(content.slice(rawOffset));
    if (sequence) {
      rawOffset += sequence[0].length;
      continue;
    }
    const codePoint = content.codePointAt(rawOffset);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    rawOffset += character.length;
    plainOffset += character.length;
  }
  return rawOffset;
}

export function replacePlainRange(content: string, start: number, end: number, replacement: string): string {
  const rawStart = rawOffsetForPlainIndex(content, start);
  const rawEnd = rawOffsetForPlainIndex(content, end);
  return `${content.slice(0, rawStart)}${replacement}${content.slice(rawEnd)}`;
}
export function fitStatusContent(content: string, width: number, preserveRight: boolean): string {
  const contentWidth = visibleWidth(content);
  if (contentWidth <= width) return content;
  if (!preserveRight) return truncateToWidth(content, width, "");
  return sliceByColumn(content, contentWidth - width, width, true);
}

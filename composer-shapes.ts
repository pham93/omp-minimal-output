import type { ContextUsage, ExtensionAPI, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
  padding,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type ComposerBox,
  type ComposerChromeContext,
  type ComposerRowContext,
  type ComposerStyle,
  type EditorTheme,
  type KeybindingsManager,
  type TUI,
} from "@oh-my-pi/pi-tui";
import { getPluginConfig, indicatorFrames } from "./config.ts";

export const MINIMAL_COMPOSER_STYLE = {
  bottomDock: "minimal-bottom-dock",
  topDock: "minimal-top-dock",
  grayscaleBottomDock: "minimal-grayscale-bottom-dock",
  grayscaleTopDock: "minimal-grayscale-top-dock",
} as const;

export type MinimalComposerStyleId = (typeof MINIMAL_COMPOSER_STYLE)[keyof typeof MINIMAL_COMPOSER_STYLE];

const MINIMAL_COMPOSER_STYLE_IDS = new Set<string>(Object.values(MINIMAL_COMPOSER_STYLE));
const GRAYSCALE_COMPOSER_STYLE_IDS = new Set<string>([
  MINIMAL_COMPOSER_STYLE.grayscaleBottomDock,
  MINIMAL_COMPOSER_STYLE.grayscaleTopDock,
]);
const GRAYSCALE_FRAME_RGB = "\x1b[38;2;142;142;142m";
const GRAYSCALE_STATUS_RGB = "\x1b[38;2;176;176;176m";
const GRAYSCALE_GUTTER_RGB = "\x1b[38;2;206;206;206m";
const ANSI_FOREGROUND_RESET = "\x1b[39m";

function grayscaleColor(text: string, color: string): string {
  return `${color}${text}${ANSI_FOREGROUND_RESET}`;
}

function grayscaleFrameColor(text: string): string {
  return grayscaleColor(text, GRAYSCALE_FRAME_RGB);
}

function grayscaleStatusColor(text: string): string {
  return grayscaleColor(text, GRAYSCALE_STATUS_RGB);
}

function grayscaleGutterColor(text: string): string {
  return grayscaleColor(text, GRAYSCALE_GUTTER_RGB);
}
const PROMPT_GUTTER = "❯ ";
const EDITOR_FRAME_CHROME = 4;
const EDITOR_FRAME_MIN_WIDTH = 10;
const PROJECT_ICON_VARIANTS = [
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
const NERD_STATUS_ICON_VARIANTS = [
  { host: "\uec19", replacement: "󰚩" },
  { host: "\uf2d2", replacement: "" },
] as const;
const PLAN_ICON_VARIANTS = ["🗺", "", "\uf2d2", "plan"] as const;
const PLAN_PAUSE_SUFFIXES = [" \uf04c", " ⏸", " ||", " (paused)"] as const;
const BUILD_STATUS_VARIANTS = {
  nerd: "󰣪 build",
  unicode: "🔨 build",
  ascii: "build",
} as const;
const USAGE_ICON_VARIANTS = ["⏱", "\uf017", "time:"] as const;
const CONTEXT_GAUGE_MAX_WIDTH = 24;
const ANSI_SEQUENCE_RE = /^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\))/u;
const STATUS_COLOR = {
  project: "statusLinePath",
  build: "statusLineModel",
  planActive: "accent",
  planPaused: "warning",
  working: "statusLineModel",
  gitClean: "statusLineGitClean",
  gitDirty: "statusLineGitDirty",
} as const;
type StatusColor = (typeof STATUS_COLOR)[keyof typeof STATUS_COLOR];
const GIT_DETAIL_VARIANTS = [
  { hostBranch: "⑂", branch: "⎇", modified: "Δ" },
  { hostBranch: "\uf126", branch: "\uf126", modified: "\uf044" },
  { hostBranch: "@", branch: "@", modified: "~" },
] as const;
const CONTEXT_GAUGE_CAPS = [
  { left: "▶", right: "◀" },
  { left: "\ue0b0", right: "\ue0b2" },
] as const;
const CHROME_STATUS_PART = {
  none: "none",
  full: "full",
  projectGit: "project-git",
  rest: "rest",
} as const;
type ChromeStatusPart = (typeof CHROME_STATUS_PART)[keyof typeof CHROME_STATUS_PART];

interface SplitStatusContent {
  projectGit: string;
  rest: string;
  leadingThroughProjectGit: string;
}

interface ExtractedPlanContent {
  body: string;
  plan: string;
}
export interface MinimalWorkingStatus {
  /** Live run start (ms epoch, 0 when idle). */
  startedAt: number;
}

export interface MinimalPlanStatus {
  enabled: boolean;
  paused: boolean;
}

const NO_PLAN_STATUS = (): MinimalPlanStatus | undefined => undefined;
const NO_CONTEXT_USAGE = (): ContextUsage | undefined => undefined;
const NO_WORKING_STATUS = (): MinimalWorkingStatus | undefined => undefined;
let contextUsageProvider: () => ContextUsage | undefined = NO_CONTEXT_USAGE;
let planStatusProvider: () => MinimalPlanStatus | undefined = NO_PLAN_STATUS;
let workingStatusProvider: () => MinimalWorkingStatus | undefined = NO_WORKING_STATUS;

function padToVisible(text: string, width: number): string {
  const current = visibleWidth(text);
  if (current === width) return text;
  if (current > width) return truncateToWidth(text, width, "");
  return `${text}${padding(width - current)}`;
}
function replaceFolderIcon(content: string): string {
  for (const variant of PROJECT_ICON_VARIANTS) {
    const host = `${variant.host} `;
    if (content.includes(host)) return content.replace(host, `${variant.replacement} `);
  }
  return content;
}
function replaceNerdStatusIcons(content: string): string {
  let result = content;
  for (const variant of NERD_STATUS_ICON_VARIANTS) {
    result = result.replaceAll(`${variant.host} `, `${variant.replacement} `);
  }
  return result;
}
function replaceGitDetails(content: string): string {
  for (const variant of GIT_DETAIL_VARIANTS) {
    const hostBranch = `${variant.hostBranch} `;
    const branchStart = content.indexOf(hostBranch);
    if (branchStart < 0) continue;

    const prefix = content.slice(0, branchStart);
    const gitAndFollowing = content
      .slice(branchStart)
      .replace(hostBranch, `${variant.branch} `)
      .replace(/\*(\d+)/gu, `${variant.modified}$1`);
    return `${prefix}${gitAndFollowing}`;
  }
  return content;
}

function formatContextPercent(percent: number): string {
  return `${percent > 0 && percent < 1 ? percent.toFixed(1) : Math.round(percent)}%`;
}

function formatContextWindow(contextWindow: number): string {
  if (contextWindow >= 1_000_000) {
    const millions = Math.round((contextWindow / 1_000_000) * 10) / 10;
    return `${millions}M`;
  }
  if (contextWindow >= 1_000) return `${Math.round(contextWindow / 1_000)}K`;
  return `${Math.max(0, Math.round(contextWindow))}`;
}

function explicitContextGauge(ctx: ComposerChromeContext, width: number, usage: ContextUsage): string | undefined {
  const percent = Number.isFinite(usage.percent) ? usage.percent : 0;
  const label = `${formatContextPercent(percent)}/${formatContextWindow(usage.contextWindow)}`;
  const labelWidth = visibleWidth(label);
  const trackWidth = width - labelWidth - 3;
  if (trackWidth < 4) return labelWidth <= width ? ctx.accentColor(label) : undefined;

  const clamped = Math.min(100, Math.max(0, percent));
  const used = Math.min(trackWidth, Math.max(0, Math.round((clamped / 100) * trackWidth)));
  const remaining = trackWidth - used;
  return `${ctx.borderColor("[")}${ctx.accentColor("█".repeat(used))}${ctx.borderColor("░".repeat(remaining))}${ctx.borderColor("]")} ${label}`;
}

function embeddedGaugeColumns(content: string): { start: number; end: number } | undefined {
  try {
    const plain = Bun.stripANSI(content);
    let best: { start: number; end: number; width: number } | undefined;

    for (const match of plain.matchAll(/\S*%\S*/gu)) {
      const text = match[0];
      const index = match.index;
      if (index === undefined || !/[\u2500-\u259f]/u.test(text)) continue;

      const start = visibleWidth(plain.slice(0, index));
      const width = visibleWidth(text);
      if (width < 8 || (best && best.width >= width)) continue;
      best = { start, end: start + width, width };
    }

    if (best) return { start: best.start, end: best.end };

    for (const match of plain.matchAll(/[\u2500-\u259f]{3,}/gu)) {
      const text = match[0];
      const index = match.index;
      if (index === undefined) continue;

      const start = visibleWidth(plain.slice(0, index));
      const width = visibleWidth(text);
      if (width < 3 || (best && best.width >= width)) continue;
      best = { start, end: start + width, width };
    }

    return best ? { start: best.start, end: best.end } : undefined;
  } catch {
    return undefined;
  }
}

function replaceContextGauge(content: string, ctx: ComposerChromeContext, widthReduction = 0): string {
  try {
    const usage = contextUsageProvider();
    if (!usage || usage.contextWindow <= 0) return content;

    const reduction = Math.max(0, Math.floor(widthReduction));
    for (const caps of CONTEXT_GAUGE_CAPS) {
      const right = content.lastIndexOf(caps.right);
      if (right < 0) continue;
      const left = content.lastIndexOf(caps.left, right - 1);
      if (left < 0) continue;

      const end = right + caps.right.length;
      const gaugeWidth = Math.min(
        CONTEXT_GAUGE_MAX_WIDTH,
        Math.max(0, visibleWidth(content.slice(left, end)) - reduction),
      );
      const gauge = explicitContextGauge(ctx, gaugeWidth, usage);
      return gauge ? `${content.slice(0, left)}${gauge}${content.slice(end)}` : content;
    }

    const columns = embeddedGaugeColumns(content);
    if (!columns) return content;

    const gaugeWidth = Math.min(CONTEXT_GAUGE_MAX_WIDTH, Math.max(0, columns.end - columns.start - reduction));
    const gauge = explicitContextGauge(ctx, gaugeWidth, usage);
    if (!gauge) return content;

    const totalWidth = visibleWidth(content);
    const left = sliceByColumn(content, 0, columns.start, true);
    const right = sliceByColumn(content, columns.end, totalWidth - columns.end, true);
    return `${left}${gauge}${right}`;
  } catch {
    return content;
  }
}

function contextGaugeLabel(usage: ContextUsage): string {
  return `${formatContextPercent(usage.percent)}/${formatContextWindow(usage.contextWindow)}`;
}

function ensureGaugeVisible(text: string, body: string, bodyWidth: number, ctx: ComposerChromeContext): string {
  try {
    const usage = contextUsageProvider();
    if (!usage || usage.contextWindow <= 0 || bodyWidth <= 0) return body;
    const plain = Bun.stripANSI(body);
    if (plain.includes(contextGaugeLabel(usage)) || /\b\d+%\s*\/\s*\d+[KMG]?\b/u.test(plain)) return body;
    const gauge = explicitContextGauge(ctx, Math.min(CONTEXT_GAUGE_MAX_WIDTH, bodyWidth), usage);
    if (!gauge) return body;
    const need = visibleWidth(gauge) + 1;
    if (need >= bodyWidth) return fitStatusContent(gauge, bodyWidth, false);
    const inner = fitStatusContent(text, bodyWidth - need, false);
    return inner ? `${inner} ${gauge}` : gauge;
  } catch {
    return body;
  }
}

function rawOffsetForPlainIndex(content: string, target: number): number {
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

function replacePlainRange(content: string, start: number, end: number, replacement: string): string {
  const rawStart = rawOffsetForPlainIndex(content, start);
  const rawEnd = rawOffsetForPlainIndex(content, end);
  return `${content.slice(0, rawStart)}${replacement}${content.slice(rawEnd)}`;
}

function statusColor(color: StatusColor, text: string, fallback: (value: string) => string): string {
  try {
    return theme.fg(color, text);
  } catch {
    return fallback(text);
  }
}
function fallbackModeStatus(content: string, ctx: ComposerChromeContext): string {
  const status = planStatusProvider();
  if (!status) return "";

  const plain = Bun.stripANSI(content);
  const nerd = plain.includes(" ");
  const unicode = plain.includes("⌂ ");
  if (status.enabled || status.paused) {
    const plan = nerd ? " Plan" : unicode ? "🗺 Plan" : "Plan";
    const pause = status.paused ? (nerd ? " " : unicode ? " ⏸" : " (paused)") : "";
    return statusColor(
      status.paused ? STATUS_COLOR.planPaused : STATUS_COLOR.planActive,
      plan + pause,
      ctx.borderColor,
    );
  }
  const build = nerd
    ? BUILD_STATUS_VARIANTS.nerd
    : unicode
      ? BUILD_STATUS_VARIANTS.unicode
      : BUILD_STATUS_VARIANTS.ascii;
  return statusColor(STATUS_COLOR.build, build, ctx.borderColor);
}

function findPlanRange(content: string): { start: number; end: number } | undefined {
  for (const icon of PLAN_ICON_VARIANTS) {
    const plan = `${icon} Plan`;
    const start = content.indexOf(plan);
    if (start < 0) continue;

    let end = start + plan.length;
    const pauseSuffix = PLAN_PAUSE_SUFFIXES.find((suffix) => content.startsWith(suffix, end));
    if (pauseSuffix) end += pauseSuffix.length;
    return { start, end };
  }

  for (const match of content.matchAll(/\bPlan\b/gu)) {
    const labelStart = match.index;
    let iconEnd = labelStart;
    while (iconEnd > 0 && /\s/u.test(content[iconEnd - 1] ?? "")) iconEnd -= 1;

    let iconStart = iconEnd;
    while (iconStart > 0 && !/[\s·|/›»\ue0b3]/u.test(content[iconStart - 1] ?? "")) iconStart -= 1;
    const start = iconStart < iconEnd ? iconStart : labelStart;

    let end = labelStart + "Plan".length;
    const pauseSuffix = PLAN_PAUSE_SUFFIXES.find((suffix) => content.startsWith(suffix, end));
    if (pauseSuffix) end += pauseSuffix.length;
    return { start, end };
  }

  return undefined;
}

function removeUsageTier(content: string): string {
  const plain = Bun.stripANSI(content);
  const window = /(?:5h|1d|7d|mo)\s+\d+%/u.exec(plain);
  if (!window || window.index === undefined) return content;

  let iconEnd = -1;
  for (const icon of USAGE_ICON_VARIANTS) {
    const index = plain.lastIndexOf(`${icon} `, window.index);
    if (index >= 0) iconEnd = Math.max(iconEnd, index + icon.length);
  }
  if (iconEnd < 0) return content;

  const between = plain.slice(iconEnd, window.index);
  if (!between.replace(/[\s·\-|/]/gu, "")) return content;
  return replacePlainRange(content, iconEnd, window.index, " ");
}
function expandThinkingEffort(content: string): string {
  let result = content;
  while (true) {
    const plain = Bun.stripANSI(result);
    const match = /\bxhi\b/u.exec(plain);
    if (!match || match.index === undefined) break;
    const start = match.index;
    const end = start + match[0].length;
    result = replacePlainRange(result, start, end, "xhigh");
  }
  return result;
}

function stripPlanStatus(content: string): string {
  let body = content;
  for (let index = 0; index < 32; index += 1) {
    const extracted = extractPlanStatus(body);
    if (!extracted.plan) break;
    body = extracted.body;
  }
  return body;
}

function formatWorkingElapsed(startedAt: number): string {
  if (!(startedAt > 0)) return "";
  const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.min(99, Math.floor(minutes / 60))}h`;
}

function sanitizeWorkingText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const MODEL_ICON_VARIANTS = ["⬢", "󰚩"] as const;

function stripDuplicateNativeModel(content: string): string {
  const plain = Bun.stripANSI(content);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const icon of MODEL_ICON_VARIANTS) {
    let from = 0;
    while (from < plain.length) {
      const start = plain.indexOf(`${icon} `, from);
      if (start < 0) break;
      const tail = plain.slice(start + icon.length + 1);
      const end = /^\S+(?:\s+\S+){0,4}(?:\s+(?:xhigh|xhi|max|high|med|low|min))?/u.exec(tail);
      if (!end) {
        from = start + icon.length + 1;
        continue;
      }
      let text = end[0];
      const effort = /\s+(xhigh|xhi|max|high|med|low|min)$/u.exec(text);
      if (effort) text = text.slice(0, text.length - effort[0].length);
      const cut = (text.split("⌂")[0] ?? text).trimEnd();
      ranges.push({ start, end: start + icon.length + 1 + cut.length });
      from = start + icon.length + 1 + end[0].length;
    }
  }
  if (ranges.length < 2) return content;
  ranges.sort((a, b) => b.start - a.start);
  let body = content;
  for (const range of ranges.slice(1)) {
    const rawStart = rawOffsetForPlainIndex(body, range.start);
    const rawEnd = rawOffsetForPlainIndex(body, range.end);
    let trimStart = rawStart;
    while (trimStart > 0 && /\s/u.test(body[trimStart - 1] ?? "")) trimStart -= 1;
    let trimEnd = rawEnd;
    while (trimEnd < body.length && /[\s·|/›»\ue0b3]/u.test(body[trimEnd] ?? "")) trimEnd += 1;
    body = `${body.slice(0, trimStart)}${trimEnd < body.length ? ` ${body.slice(trimEnd)}` : ""}`;
  }
  return body;
}
function workingPrefix(ctx: ComposerChromeContext): string {
  try {
    const working = workingStatusProvider();
    if (!working || !(working.startedAt > 0)) return "";

    const elapsed = formatWorkingElapsed(working.startedAt);
    const frames = indicatorFrames(getPluginConfig());
    const frame = frames.length > 0 ? (frames[0] ?? "") : "";
    const text = `${frame}${elapsed ? ` ${elapsed}` : ""}`.trim();
    if (!text) return "";
    return statusColor(STATUS_COLOR.working, text, ctx.borderColor);
  } catch {
    return "";
  }
}
function decorateStatusContent(content: string, ctx: ComposerChromeContext, gaugeWidthReduction = 0): string {
  try {
    const icons = replaceNerdStatusIcons(replaceFolderIcon(content));
    const usage = removeUsageTier(icons);
    const effort = expandThinkingEffort(usage);
    const details = replaceGitDetails(effort);
    const model = stripDuplicateNativeModel(details);
    const body = stripPlanStatus(model);
    return replaceContextGauge(body, ctx, gaugeWidthReduction);
  } catch {
    return content;
  }
}
function splitProjectGitStatus(content: string, ctx: ComposerChromeContext): SplitStatusContent {
  try {
    const plain = Bun.stripANSI(content);
    let projectStart = -1;
    let projectIcon = "";
    for (const variant of PROJECT_ICON_VARIANTS) {
      for (const needle of [`${variant.replacement} `, `${variant.host} `]) {
        const index = plain.indexOf(needle);
        if (index < 0 || (projectStart >= 0 && index >= projectStart)) continue;
        projectStart = index;
        projectIcon = needle.trimEnd();
      }
    }
    if (projectStart < 0) return { projectGit: "", rest: content, leadingThroughProjectGit: content };

    const projectValue = /^\s+\S+/u.exec(plain.slice(projectStart + projectIcon.length));
    if (!projectValue) return { projectGit: "", rest: content, leadingThroughProjectGit: content };
    const projectEnd = projectStart + projectIcon.length + projectValue[0].length;

    let branchStart = -1;
    let branchIcon = "";
    for (const variant of GIT_DETAIL_VARIANTS) {
      for (const needle of [`${variant.branch} `, `${variant.hostBranch} `]) {
        const index = plain.indexOf(needle, projectEnd);
        if (index < 0 || (branchStart >= 0 && index >= branchStart)) continue;
        branchStart = index;
        branchIcon = needle.trimEnd();
      }
    }

    let titleEnd = projectEnd;
    if (branchStart >= 0) {
      const branchValue = /^\s+\S+/u.exec(plain.slice(branchStart + branchIcon.length));
      if (branchValue) {
        titleEnd = branchStart + branchIcon.length + branchValue[0].length;
        while (true) {
          const status = /^\s+(?:Δ||~|\+|\?)\d+/u.exec(plain.slice(titleEnd));
          if (!status) break;
          titleEnd += status[0].length;
        }
      } else {
        branchStart = -1;
      }
    }
    let removalEnd = titleEnd;
    while (removalEnd < plain.length && /[\s·|/›»\ue0b3<>]/u.test(plain[removalEnd] ?? "")) removalEnd += 1;

    const projectText = plain.slice(projectStart, projectEnd);
    let projectGit = statusColor(STATUS_COLOR.project, projectText, ctx.borderColor);
    if (branchStart >= 0) {
      const branch = plain.slice(branchStart, titleEnd);
      const color = /(?:Δ||~|\+|\?)\d+/u.test(branch) ? STATUS_COLOR.gitDirty : STATUS_COLOR.gitClean;
      projectGit += `${ctx.borderColor(" · ")}${statusColor(color, branch, ctx.borderColor)}`;
    }

    const rawStart = rawOffsetForPlainIndex(content, projectStart);
    const rawEnd = rawOffsetForPlainIndex(content, removalEnd);
    const rest = `${content.slice(0, rawStart)}${content.slice(rawEnd)}`.replace(
      /[\s·|/›»\ue0b3<>]+((?:\x1b\[[0-9;]*m)*)$/u,
      "$1",
    );
    return {
      projectGit,
      rest,
      leadingThroughProjectGit: `${content.slice(0, rawStart)}${projectGit}`,
    };
  } catch {
    return { projectGit: "", rest: content, leadingThroughProjectGit: content };
  }
}

function extractPlanStatus(content: string): ExtractedPlanContent {
  const plain = Bun.stripANSI(content);
  const range = findPlanRange(plain);
  if (!range) return { body: content, plan: "" };

  let removalStart = range.start;
  while (removalStart > 0 && /[\s·|/›»\ue0b3]/u.test(plain[removalStart - 1] ?? "")) removalStart -= 1;

  let removalEnd = range.end;
  const trailingPattern = removalStart < range.start ? /\s/u : /[\s·|/›»\ue0b3]/u;
  while (removalEnd < plain.length && trailingPattern.test(plain[removalEnd] ?? "")) removalEnd += 1;

  const rawRemovalStart = rawOffsetForPlainIndex(content, removalStart);
  const rawPlanStart = rawOffsetForPlainIndex(content, range.start);
  const rawPlanEnd = rawOffsetForPlainIndex(content, range.end);
  const rawEnd = rawOffsetForPlainIndex(content, removalEnd);
  return {
    body: `${content.slice(0, rawRemovalStart)}${content.slice(rawEnd)}`,
    plan: content.slice(rawPlanStart, rawPlanEnd),
  };
}

function fitStatusContent(content: string, width: number, preserveRight: boolean): string {
  const contentWidth = visibleWidth(content);
  if (contentWidth <= width) return content;
  if (!preserveRight) return truncateToWidth(content, width, "");
  return sliceByColumn(content, contentWidth - width, width, true);
}

function chromeBody(ctx: ComposerChromeContext, part: ChromeStatusPart): string {
  try {
    const width = Math.max(0, ctx.width - 2);
    if (part === CHROME_STATUS_PART.none || !ctx.topBorder?.content || width < 2) {
      return ctx.borderColor(ctx.box.horizontal.repeat(width));
    }

    const pad = ctx.borderColor(" ");
    const contentWidth = width - 2;
    const gaugeWidthReduction = part === CHROME_STATUS_PART.rest ? 2 : 0;
    const decorated = decorateStatusContent(ctx.topBorder.content, ctx, gaugeWidthReduction);
    if (part === CHROME_STATUS_PART.full) {
      const separated = splitProjectGitStatus(decorated, ctx);
      const prefix = workingPrefix(ctx);
      const prefixed = prefix
        ? `${prefix} ${separated.leadingThroughProjectGit}`.trim()
        : separated.leadingThroughProjectGit;
      const statusBody = prefixed;
      const modeStatus = fallbackModeStatus(decorated, ctx);
      const modeGap = modeStatus ? 1 : 0;
      const bodyWidth = Math.max(0, contentWidth - visibleWidth(modeStatus) - modeGap);
      const fitted = fitStatusContent(statusBody, bodyWidth, false);
      const body = ensureGaugeVisible(statusBody, fitted, bodyWidth, ctx);
      const fill = ctx.borderColor(ctx.box.horizontal.repeat(Math.max(0, bodyWidth - visibleWidth(body))));
      const pinnedMode = modeStatus ? `${pad}${modeStatus}` : "";
      return `${pad}${body}${fill}${pinnedMode}${pad}`;
    }
    const split = splitProjectGitStatus(decorated, ctx);
    if (part === CHROME_STATUS_PART.projectGit) {
      const title = fitStatusContent(split.projectGit, contentWidth, true);
      const fill = ctx.borderColor(ctx.box.horizontal.repeat(Math.max(0, contentWidth - visibleWidth(title))));
      return `${pad}${fill}${title}${pad}`;
    }

    const prefix = workingPrefix(ctx);
    const prefixedRest = prefix ? `${prefix} ${split.rest}`.trim() : split.rest;
    const modeStatus = fallbackModeStatus(decorated, ctx);
    const modeGap = modeStatus ? 1 : 0;
    const bodyWidth = Math.max(0, contentWidth - visibleWidth(modeStatus) - modeGap);
    const fitted = fitStatusContent(prefixedRest, bodyWidth, false);
    const body = ensureGaugeVisible(prefixedRest, fitted, bodyWidth, ctx);
    const fill = ctx.borderColor(ctx.box.horizontal.repeat(Math.max(0, bodyWidth - visibleWidth(body))));
    const pinnedMode = modeStatus ? `${pad}${modeStatus}` : "";
    return `${pad}${body}${fill}${pinnedMode}${pad}`;
  } catch {
    const width = Math.max(0, ctx.width - 2);
    return ctx.borderColor(ctx.box.horizontal.repeat(width));
  }
}

function chromeLine(
  ctx: ComposerChromeContext,
  edge: "top" | "bottom",
  part: ChromeStatusPart,
  grayscale: boolean,
): string {
  try {
    const left = edge === "top" ? ctx.box.topLeft : ctx.box.bottomLeft;
    const right = edge === "top" ? ctx.box.topRight : ctx.box.bottomRight;
    if (grayscale) {
      return `${grayscaleFrameColor(left)}${grayscaleStatusColor(Bun.stripANSI(chromeBody(ctx, part)))}${grayscaleFrameColor(right)}`;
    }
    return `${ctx.borderColor(left)}${chromeBody(ctx, part)}${ctx.borderColor(right)}`;
  } catch {
    const left = edge === "top" ? ctx.box.topLeft : ctx.box.bottomLeft;
    const right = edge === "top" ? ctx.box.topRight : ctx.box.bottomRight;
    return `${ctx.borderColor(left)}${ctx.borderColor(ctx.box.horizontal.repeat(Math.max(0, ctx.width - 2)))}${ctx.borderColor(right)}`;
  }
}

function innerRow(ctx: ComposerRowContext, grayscale: boolean): string[] {
  const gutter = grayscale ? grayscaleGutterColor(Bun.stripANSI(ctx.gutter)) : ctx.gutter;
  return [`${gutter}${ctx.text}${ctx.pad}`];
}

function composerStyle(id: MinimalComposerStyleId, statusEdge: "top" | "bottom", grayscale = false): ComposerStyle {
  return {
    id,
    filledSurface: false,
    sideBorders: false,
    verticalChrome: 2,
    statusAttachment: "top-border",
    bottomBar: "none",
    bottomBarGap: false,
    defaultPromptGutter: PROMPT_GUTTER,

    defaultPaddingX(): number {
      return 0;
    },

    sideChromeWidth(): number {
      return 0;
    },

    renderTop(ctx: ComposerChromeContext): string {
      const part = statusEdge === "top" ? CHROME_STATUS_PART.full : CHROME_STATUS_PART.projectGit;
      return chromeLine(ctx, "top", part, grayscale);
    },

    renderRow(ctx: ComposerRowContext): string[] {
      return innerRow(ctx, grayscale);
    },

    renderBottom(ctx: ComposerChromeContext): string {
      const part = statusEdge === "bottom" ? CHROME_STATUS_PART.rest : CHROME_STATUS_PART.none;
      return chromeLine(ctx, "bottom", part, grayscale);
    },
  };
}

const COMPOSER_SHAPES = [
  {
    label: "Minimal Output · Bottom Dock",
    description: "Rounded prompt with the configured OMP status and context gauge in the bottom rule",
    style: composerStyle(MINIMAL_COMPOSER_STYLE.bottomDock, "bottom"),
  },
  {
    label: "Minimal Output · Top Dock",
    description: "Rounded prompt with the configured OMP status and context gauge in the top rule",
    style: composerStyle(MINIMAL_COMPOSER_STYLE.topDock, "top"),
  },
  {
    label: "Minimal Output · Grayscale Bottom Dock",
    description: "Neutral grayscale prompt with OMP status and context gauge in the bottom rule",
    style: composerStyle(MINIMAL_COMPOSER_STYLE.grayscaleBottomDock, "bottom", true),
  },
  {
    label: "Minimal Output · Grayscale Top Dock",
    description: "Neutral grayscale prompt with OMP status and context gauge in the top rule",
    style: composerStyle(MINIMAL_COMPOSER_STYLE.grayscaleTopDock, "top", true),
  },
] as const;
function framedChrome(
  line: string,
  bodyWidth: number,
  leftCap: string,
  rightCap: string,
  horizontal: string,
  borderColor: (text: string) => string,
): string {
  const lineWidth = visibleWidth(line);
  const body = lineWidth >= 2 ? sliceByColumn(line, 1, lineWidth - 2, true) : "";
  const fitted = truncateToWidth(body, bodyWidth, "");
  const missing = Math.max(0, bodyWidth - visibleWidth(fitted));
  const leftFill = horizontal.repeat(Math.floor(missing / 2));
  const rightFill = horizontal.repeat(missing - visibleWidth(leftFill));
  return `${borderColor(leftCap)}${borderColor(leftFill)}${fitted}${borderColor(rightFill)}${borderColor(rightCap)}`;
}

function framedRow(line: string, innerWidth: number, box: ComposerBox, borderColor: (text: string) => string): string {
  return `${borderColor(box.vertical)} ${padToVisible(line, innerWidth)} ${borderColor(box.vertical)}`;
}

function bottomChromeIndex(lines: readonly string[], innerWidth: number, box: ComposerBox): number {
  for (let index = lines.length - 1; index >= 1; index -= 1) {
    const plain = Bun.stripANSI(lines[index] ?? "");
    if (visibleWidth(plain) === innerWidth && plain.startsWith(box.bottomLeft) && plain.endsWith(box.bottomRight)) {
      return index;
    }
  }
  return -1;
}

export class MinimalPromptEditor extends CustomEditor {
  readonly #box: ComposerBox;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
    this.#box = theme.symbols.boxRound;
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(0, Math.trunc(width));
    try {
      if (!MINIMAL_COMPOSER_STYLE_IDS.has(this.getBorderStyle()) || safeWidth < EDITOR_FRAME_MIN_WIDTH) {
        return [...super.render(safeWidth)];
      }
      const borderColor = GRAYSCALE_COMPOSER_STYLE_IDS.has(this.getBorderStyle())
        ? grayscaleFrameColor
        : this.borderColor;

      const innerWidth = safeWidth - EDITOR_FRAME_CHROME;
      const inner = [...super.render(innerWidth)];
      const bottom = bottomChromeIndex(inner, innerWidth, this.#box);
      if (inner.length === 0 || bottom < 1) return inner.map((line) => truncateToWidth(line, safeWidth, ""));

      const bodyWidth = safeWidth - 2;
      const framed: string[] = [
        framedChrome(
          inner[0] ?? "",
          bodyWidth,
          this.#box.topLeft,
          this.#box.topRight,
          this.#box.horizontal,
          borderColor,
        ),
      ];

      for (let index = 1; index < bottom; index += 1) {
        framed.push(framedRow(inner[index] ?? "", innerWidth, this.#box, borderColor));
      }

      framed.push(
        framedChrome(
          inner[bottom] ?? "",
          bodyWidth,
          this.#box.bottomLeft,
          this.#box.bottomRight,
          this.#box.horizontal,
          borderColor,
        ),
      );

      for (let index = bottom + 1; index < inner.length; index += 1) {
        framed.push(`  ${truncateToWidth(inner[index] ?? "", Math.max(0, safeWidth - 2), "")}`);
      }

      return framed.map((line) => truncateToWidth(line, safeWidth, ""));
    } catch {
      return [...super.render(safeWidth)];
    }
  }
}

export function registerMinimalComposerShapes(pi: ExtensionAPI): void {
  for (const shape of COMPOSER_SHAPES) pi.registerComposerShape(shape);
}

export function updateMinimalPromptEditorProviders(
  getContextUsage: () => ContextUsage | undefined,
  getPlanStatus: () => MinimalPlanStatus | undefined,
  getWorkingStatus?: () => MinimalWorkingStatus | undefined,
): void {
  contextUsageProvider = getContextUsage;
  planStatusProvider = getPlanStatus;
  workingStatusProvider = getWorkingStatus ?? NO_WORKING_STATUS;
}

export function installMinimalPromptEditor(
  ui: ExtensionUIContext,
  getContextUsage: () => ContextUsage | undefined,
  getPlanStatus: () => MinimalPlanStatus | undefined,
  getWorkingStatus?: () => MinimalWorkingStatus | undefined,
): () => void {
  updateMinimalPromptEditorProviders(getContextUsage, getPlanStatus, getWorkingStatus);
  ui.setEditorComponent((tui, theme, keybindings) => new MinimalPromptEditor(tui, theme, keybindings));
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    contextUsageProvider = NO_CONTEXT_USAGE;
    planStatusProvider = NO_PLAN_STATUS;
    workingStatusProvider = NO_WORKING_STATUS;
    try {
      ui.setEditorComponent(undefined);
    } catch {
      // Interactive UI teardown may already have released the editor host.
    }
  };
}

/**
 * Status text pipeline for the prompt docks: the icon, usage, effort, plan,
 * model, and context-gauge rewrites applied to OMP's status-line text, plus the
 * live providers (context usage, plan mode, working run) those rewrites read.
 * Frame rendering lives in `composer-shapes.ts`; the editor that consumes both
 * lives in `composer-editor.ts`.
 */
import { theme, type ContextUsage, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ComposerChromeContext } from "@oh-my-pi/pi-tui";
import { getPluginConfig, indicatorFrames } from "../core/config.ts";
import { replaceContextGauge } from "./composer-gauge.ts";
import {
  BUILD_STATUS_VARIANTS,
  GIT_DETAIL_VARIANTS,
  MODEL_ICON_VARIANTS,
  NERD_STATUS_ICON_VARIANTS,
  PLAN_ICON_VARIANTS,
  PLAN_PAUSE_SUFFIXES,
  PROJECT_ICON_VARIANTS,
  STATUS_COLOR,
  USAGE_ICON_VARIANTS,
  rawOffsetForPlainIndex,
  replacePlainRange,
  type StatusColor,
} from "./composer-primitives.ts";

export interface SplitStatusContent {
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
const NO_SESSION_NAME = (): string | undefined => undefined;
const NO_CONTEXT_USAGE = (): ContextUsage | undefined => undefined;
const NO_WORKING_STATUS = (): MinimalWorkingStatus | undefined => undefined;
let contextUsageProvider: () => ContextUsage | undefined = NO_CONTEXT_USAGE;
let planStatusProvider: () => MinimalPlanStatus | undefined = NO_PLAN_STATUS;
let workingStatusProvider: () => MinimalWorkingStatus | undefined = NO_WORKING_STATUS;
let sessionNameProvider: () => string | undefined = NO_SESSION_NAME;
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
function statusColor(color: StatusColor, text: string, fallback: (value: string) => string): string {
  try {
    return theme.fg(color, text);
  } catch {
    return fallback(text);
  }
}
export function fallbackModeStatus(content: string, ctx: ComposerChromeContext): string {
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

interface UsageWindowMatch {
  kind: string;
  start: number;
  end: number;
  usedPercent: number;
}
function filterUsageStatus(content: string): string {
  const plain = Bun.stripANSI(content);
  const windowRegex = /\b(5h|1d|7d|mo)\s+(\d+)%(?:\s*\([^)]*\))?/gu;
  const matches: UsageWindowMatch[] = [];

  for (const match of plain.matchAll(windowRegex)) {
    if (match.index !== undefined && match[1] && match[2]) {
      matches.push({
        kind: match[1],
        usedPercent: Number.parseInt(match[2], 10),
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  if (matches.length === 0) return content;

  const groups: UsageWindowMatch[][] = [];
  let currentGroup: UsageWindowMatch[] = [];

  for (const m of matches) {
    if (currentGroup.length === 0) {
      currentGroup.push(m);
    } else {
      const prev = currentGroup[currentGroup.length - 1]!;
      const gap = plain.slice(prev.end, m.start);
      if (/^[\s·\-|/]+$/u.test(gap)) {
        currentGroup.push(m);
      } else {
        groups.push(currentGroup);
        currentGroup = [m];
      }
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  let result = content;

  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i];
    if (!group || group.length === 0) continue;

    const first = group[0]!;
    const last = group[group.length - 1]!;
    const chosen = group.find((w) => w.kind === "5h") ?? group.find((w) => w.kind === "7d") ?? first;

    let replaceStart = first.start;
    let iconEnd = -1;
    for (const icon of USAGE_ICON_VARIANTS) {
      const idx = plain.lastIndexOf(icon, first.start);
      if (idx >= 0) {
        const afterIcon = idx + icon.length;
        const between = plain.slice(afterIcon, first.start);
        if (between.length <= 32 && /^[\s·\-|/\w]*$/u.test(between)) {
          iconEnd = Math.max(iconEnd, afterIcon);
        }
      }
    }

    let prefix = "";
    if (iconEnd >= 0) {
      replaceStart = iconEnd;
      prefix = " ";
    }

    const replaceEnd = last.end;
    const rawReplaceStart = rawOffsetForPlainIndex(result, replaceStart);
    const rawReplaceEnd = rawOffsetForPlainIndex(result, replaceEnd);
    const rawChosenStart = rawOffsetForPlainIndex(result, chosen.start);
    const rawChosenEnd = rawOffsetForPlainIndex(result, chosen.end);
    const rawChosen = result.slice(rawChosenStart, rawChosenEnd);
    const remainingPercent = Math.max(0, Math.min(100, 100 - chosen.usedPercent));
    const rawAdjusted = rawChosen.replace(/(\d+)\s*%/u, `${remainingPercent}%`);
    result = `${result.slice(0, rawReplaceStart)}${prefix}${rawAdjusted}${result.slice(rawReplaceEnd)}`;
  }

  return result;
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
export function workingPrefix(ctx: ComposerChromeContext): string {
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

/** A JS crash dump: stack frames, or an `Error` head, never a status summary. */
const STATUS_STACK_FRAME_RE = /(?:^|\n)\s*at\s+\S/u;
const STATUS_ERROR_HEAD_RE = /^(?:\W{1,3}\s*)?(?:[A-Z][\w$]*Error|Error)\s*:/u;
// C0 controls except ESC: SGR color sequences are legitimate status text, tabs and bells are not.
const STATUS_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]+/gu;
const STATUS_NEWLINE_RE = /\s*[\r\n\u2028\u2029]+\s*/gu;

/**
 * A status text that is a JavaScript crash dump — stack frames, or an `Error: …` head — is not
 * session status. It reaches the composer when a failed segment provider or an extension that
 * stringifies an exception into its hook status hands its error text to the status surface.
 */
export function isCrashDumpText(text: string): boolean {
  if (!text) return false;
  const plain = Bun.stripANSI(text).trim();
  if (!plain) return false;
  return STATUS_STACK_FRAME_RE.test(text) || STATUS_ERROR_HEAD_RE.test(plain);
}

/**
 * The docks render one status row, so the host's status text is reduced to one line. A crash dump is
 * dropped instead of painting a stack trace where the project, model, and gauge belong; any other
 * multi-line content is flattened onto the row.
 */
export function dockStatusContent(content: string): string {
  if (!content) return content;
  const trimmed = content.trim();
  if (!trimmed) return "";
  const plain = Bun.stripANSI(trimmed);
  if (STATUS_STACK_FRAME_RE.test(content) || STATUS_ERROR_HEAD_RE.test(plain)) return "";
  return trimmed
    .replace(STATUS_CONTROL_RE, " ")
    .replace(STATUS_NEWLINE_RE, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

/** Guard key for the host status wrapper's row filter; a `Symbol.for` key survives hot reload. */
const STATUS_ROW_GUARD = Symbol.for("@local/omp-minimal-output/status-row-guard");

/**
 * Keep crash dumps out of the composer's status surface. The host renders its status line — including
 * the hook-status rows extensions push through `ui.setStatus` — through the wrapper component the
 * composer mounts; one of those rows carrying a stack trace would sit right under the dock's status
 * row. Rows are otherwise untouched, and the guard restores the host render on disable.
 */
export function installStatusRowGuard(wrapper: unknown): (() => void) | undefined {
  if (!wrapper || typeof wrapper !== "object") return;
  const record = wrapper as Record<string | symbol, unknown>;
  if (record[STATUS_ROW_GUARD]) return;
  const native = record["render"];
  if (typeof native !== "function") return;

  const guarded = function (this: unknown, width: number): unknown {
    const rows = (native as (width: number) => unknown).call(this, width);
    if (!Array.isArray(rows)) return rows;
    return rows.filter((row) => typeof row !== "string" || !isCrashDumpText(row));
  };
  record["render"] = guarded;

  let active = true;
  const restore = (): void => {
    if (!active) return;
    active = false;
    if (record["render"] === guarded) record["render"] = native;
    if (record[STATUS_ROW_GUARD] === restore) delete record[STATUS_ROW_GUARD];
  };
  record[STATUS_ROW_GUARD] = restore;
  return restore;
}

/** Restore the host status wrapper's own render (disable, teardown, or widget unmount). */
export function restoreStatusRowGuard(wrapper: unknown): void {
  if (!wrapper || typeof wrapper !== "object") return;
  const restore = (wrapper as Record<string | symbol, unknown>)[STATUS_ROW_GUARD];
  if (typeof restore === "function") (restore as () => void)();
}

const STATUS_SEPARATOR_RE = /[\s·|/›»\ue0b3<>]/u;

/**
 * Drop the host's `session_name` segment — the auto-generated task title — from the dock's status
 * row. It is task metadata rather than session state, it is the longest and least predictable text on
 * the row, and presets that list it would otherwise paint a whole task name (often one that reads
 * like the failure it describes) where the model, project, and gauge belong.
 */
function stripSessionTitle(content: string): string {
  let title: string | undefined;
  try {
    title = sessionNameProvider()?.trim();
  } catch {
    title = undefined;
  }
  if (!title || title.length < 4) return content;

  const plain = Bun.stripANSI(content);
  const start = plain.indexOf(title);
  if (start < 0) return content;
  // Only a whole segment: a title that happens to be a slice of the project path must stay put.
  const before = start === 0 ? "" : (plain[start - 1] ?? "");
  const after = plain[start + title.length] ?? "";
  if (before && !STATUS_SEPARATOR_RE.test(before)) return content;
  if (after && !STATUS_SEPARATOR_RE.test(after)) return content;

  let rawStart = rawOffsetForPlainIndex(content, start);
  let rawEnd = rawOffsetForPlainIndex(content, start + title.length);
  while (rawStart > 0 && STATUS_SEPARATOR_RE.test(content[rawStart - 1] ?? "")) rawStart -= 1;
  while (rawEnd < content.length && STATUS_SEPARATOR_RE.test(content[rawEnd] ?? "")) rawEnd += 1;
  // The segment is painted in the accent color: take its wrapping SGR codes with it so the next
  // segment does not inherit them.
  while (rawStart > 0) {
    const match = /(?:\x1b\[[0-9;]*m)+$/u.exec(content.slice(0, rawStart));
    if (!match) break;
    rawStart -= match[0].length;
  }
  while (rawEnd < content.length) {
    const match = /^(?:\x1b\[[0-9;]*m)+/u.exec(content.slice(rawEnd));
    if (!match) break;
    rawEnd += match[0].length;
  }
  return content.slice(0, rawStart) + content.slice(rawEnd);
}

export function decorateStatusContent(content: string, ctx: ComposerChromeContext, gaugeWidthReduction = 0): string {
  const single = dockStatusContent(content);
  try {
    const icons = replaceNerdStatusIcons(replaceFolderIcon(single));
    const usage = filterUsageStatus(icons);
    const effort = expandThinkingEffort(usage);
    const details = replaceGitDetails(effort);
    const model = stripDuplicateNativeModel(details);
    const body = stripSessionTitle(stripPlanStatus(model));
    return replaceContextGauge(body, ctx, contextUsageProvider(), gaugeWidthReduction);
  } catch {
    return single;
  }
}
export function splitProjectGitStatus(content: string, ctx: ComposerChromeContext): SplitStatusContent {
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
export function createPlanStatusProvider(ctx: ExtensionContext): () => MinimalPlanStatus | undefined {
  let cachedLeafId: string | null | undefined;
  let cachedStatus: MinimalPlanStatus | undefined;

  return () => {
    try {
      const leafId = ctx.sessionManager.getLeafId();
      if (leafId === cachedLeafId) return cachedStatus;

      const branch = ctx.sessionManager.getBranch();
      let nextStatus: MinimalPlanStatus = { enabled: false, paused: false };
      for (let index = branch.length - 1; index >= 0; index -= 1) {
        const entry = branch[index];
        if (entry?.type !== "mode_change") continue;
        if (entry.mode === "plan") nextStatus = { enabled: true, paused: false };
        else if (entry.mode === "plan_paused") nextStatus = { enabled: false, paused: true };
        break;
      }

      cachedLeafId = leafId;
      cachedStatus = nextStatus;
      return cachedStatus;
    } catch {
      return undefined;
    }
  };
}
/** Live context usage for the frame layer's gauge fitting; undefined when unavailable. */
export function currentContextUsage(): ContextUsage | undefined {
  return contextUsageProvider();
}

/**
 * Install the live providers the status rewrites read. Called on every session
 * bind so a session switch re-points the docks at the new session state.
 */
export function updateMinimalPromptEditorProviders(
  getContextUsage: () => ContextUsage | undefined,
  getPlanStatus: () => MinimalPlanStatus | undefined,
  getWorkingStatus?: () => MinimalWorkingStatus | undefined,
  getSessionName?: () => string | undefined,
): void {
  contextUsageProvider = getContextUsage;
  planStatusProvider = getPlanStatus;
  workingStatusProvider = getWorkingStatus ?? NO_WORKING_STATUS;
  // Omitting the getter leaves the current one in place: the editor install path passes three
  // arguments, and silently clearing the session name there disabled the dock's title strip.
  if (getSessionName) sessionNameProvider = getSessionName;
}

/** Drop every provider; the editor disposer calls this on disable and teardown. */
export function resetStatusContentProviders(): void {
  contextUsageProvider = NO_CONTEXT_USAGE;
  planStatusProvider = NO_PLAN_STATUS;
  workingStatusProvider = NO_WORKING_STATUS;
  sessionNameProvider = NO_SESSION_NAME;
}

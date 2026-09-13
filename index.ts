import type { ExtensionAPI, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import type { markFramedBlockComponent } from "@oh-my-pi/pi-coding-agent/tui/output-block";
import { Container, visibleWidth } from "@oh-my-pi/pi-tui";
import { tmpdir } from "node:os";
import { statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { collapseToolText } from "./filters.ts";
import { toolActionLabel, wrapLatestLines } from "./text.ts";
import {
  LINE_WIDTH_RATIO,
  TOOL_INDENT,
  advanceSpinFrame,
  anySettling,
  elapsedSuffix,
  formatRowLine,
  markSettling,
  paintAt,
  textFades,
} from "./theme.ts";
import {
  getPluginConfig,
  lockfilePath,
  projectOverridePaths,
  reloadPluginConfig,
  wrapTool,
} from "./config.ts";
import {
  argsFingerprint,
  durationSuffix,
  eventFingerprint,
  fpsByBase,
  isToolError,
  stashFullText,
  toolFingerprint,
  toolFpBase,
  toolResultText,
} from "./results.ts";
import { type MarkFlush, markFlush } from "./loaders.ts";
import { renderPrettyEditCard } from "./edit-card.ts";
import { renderEvalCard } from "./eval-card.ts";
import { installReadGroupSkin } from "./read-group.ts";

// Elapsed base for the live row timer (ms epoch). Maintained by the
// tool handlers below; renderers only read it.
let spinStartedAt = 0;
let activityStartedAt = 0;
let activityLabel = "";
let activityLive = false;
let activityTotal = "";
// Per-turn mirror identity for the aside-channel records below. The live row
// is sent once per turn; a settled record goes out on every tool drain.
// Renderer state freezes in message details so old rows never mirror a later run.
let activityRunId: string | null = null;
let activityLiveSent = false;
let activityApiDead = false;
const activityProcessTag = Math.floor(Math.random() * 36 ** 6).toString(36);
let activityRunSeq = 0;
const activitySettledTotals = new Map<string, { total: number; label: string }>();
const liveRuns = new Map<string, { label: string; startedAt: number; fp: string }>();
let activityLeadFp = "";
let enabled = true;
let thoughtLive = false;
let thoughtStartedAt = 0;
let thoughtText = "";
let thoughtSettledLabel = "";
let thoughtWidgetOn = false;
let thoughtUi:
  | {
      setWidget?: (key: string, content: unknown, options?: { placement?: string }) => void;
      requestRender?: () => void;
    }
  | undefined;
const THOUGHT_PREVIEW_LINES = 3;
const THOUGHT_WIDGET_KEY = "minimal-thinking";
// Tools already re-registered with a custom card. wrapTool() from config.ts
// decides membership (WRAP_CANDIDATES minus native* opt-outs).
const wrapApplied = new Set<string>();
let lastConfigMtimes = "";

function configMtimeKey(): string {
  const paths = [lockfilePath(), ...projectOverridePaths()];
  return paths
    .map((p) => {
      try {
        return String(statSync(p).mtimeMs);
      } catch {
        return "0";
      }
    })
    .join("|");
}

function maybeReloadConfig(): void {
  try {
    const key = configMtimeKey();
    if (lastConfigMtimes === "") {
      lastConfigMtimes = key;
      return;
    }
    if (key !== lastConfigMtimes) {
      lastConfigMtimes = key;
      reloadPluginConfig();
    }
  } catch {
    // Config reload is best-effort; paint with the cached config.
  }
}

interface GroupRow {
  fp: string;
  body: string;
  live: boolean;
  error: boolean;
  right: string;
  startedAt: number;
}
interface ToolGroup {
  label: string;
  rows: Map<string, GroupRow>;
}
const toolGroups = new Map<string, ToolGroup>();
const fpToGroup = new Map<string, string>();

type TextItem = { type: string; text?: string };

function textItemOf(content: unknown): { list: TextItem[]; item: TextItem } | undefined {
  if (!Array.isArray(content)) return undefined;
  const list = content as TextItem[];
  const item = list.find((c) => c?.type === "text" && typeof c.text === "string");
  return item?.text !== undefined ? { list, item } : undefined;
}

function stripFence(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1].trim() : t;
}

// MCP bridges deliver the payload twice: raw JSON plus a fenced
// {"result": "<raw>"} envelope text item. Collapse the inner payload and
// drop the envelope so rows stay one collapsed block.
function unwrapResultEnvelope(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stripFence(text));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>);
      if (entries.length === 1 && entries[0][0] === "result" && typeof entries[0][1] === "string") {
        const inner = (entries[0][1] as string).trim();
        if (inner.startsWith("{") || inner.startsWith("[")) {
          JSON.parse(inner);
          return entries[0][1] as string;
        }
      }
    }
  } catch {}
  return null;
}

function isMcpEnvelopeDuplicate(text: string, raw: string): boolean {
  if (!text || !raw) return false;
  if (text === raw) return true;
  const t = stripFence(text).trim();
  const r = raw.trim();
  if (t === r) return true;
  const inner = unwrapResultEnvelope(text);
  if (inner !== null && inner.trim() === r) return true;
  const head = r.slice(0, 120);
  if (head.length <= 40) return false;
  if (t.includes(head)) return true;
  return inner !== null && inner.includes(head);
}

function pruneMcpEnvelopes(list: TextItem[], anchor: TextItem, raw: string): TextItem[] {
  return list.filter(
    (c) => c === anchor || c.type !== "text" || !isMcpEnvelopeDuplicate(typeof c.text === "string" ? c.text : "", raw),
  );
}

function isCollapseTarget(event: ToolResultEvent): boolean {
  return (
    event.type === "tool_result" &&
    ([
      "edit",
      "read",
      "bash",
      "ast_grep",
      "debug",
      "eval",
      "github",
      "glob",
      "grep",
      "lsp",
      "checkpoint",
      "rewind",
      "context_notes",
      "new_context",
      "security_scan",
      "task",
      "hub",
      "todo",
      "web_search",
      "write",
      "memory_edit",
      "retain",
      "recall",
      "reflect",
      "learn",
      "manage_skill",
    ].includes(event.toolName) ||
      event.toolName.startsWith("mcp__") ||
      event.toolName.includes("/"))
  );
}

async function spillToolOutput(toolName: string, original: string): Promise<string | null> {
  try {
    const safe = toolName.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 32) || "tool";
    const path = `${tmpdir()}/omp-minimal-${safe}-${Date.now()}.log`;
    await writeFile(path, original, "utf-8");
    return path;
  } catch {
    return null;
  }
}

function summarizeEvent(event: unknown): string {
  try {
    const e = event as Record<string, unknown>;
    const tool = String(e["toolName"] ?? e["name"] ?? "tool");
    const input = (e["input"] ?? e["args"] ?? {}) as Record<string, unknown>;
    const raw = input["command"] ?? input["path"] ?? input["pattern"] ?? input["query"] ?? input["file"] ?? "";
    const oneLine = String(raw ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const short = oneLine;
    return short ? `${tool} ${short}` : tool;
  } catch {
    return "tool";
  }
}

// English intent (`arguments.i`, literal key; no pi-wire dependency).
function intentFromUnknown(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function intentFromToolArgs(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  return intentFromUnknown((args as Record<string, unknown>)["i"]);
}

function intentFromAssistantMessage(message: unknown): string | undefined {
  try {
    const content = (message as { content?: unknown })?.content;
    if (!Array.isArray(content)) return undefined;
    let found: string | undefined;
    for (const item of content as Array<{ type?: unknown; arguments?: unknown }>) {
      if (item?.type !== "toolCall") continue;
      const next = intentFromToolArgs(item.arguments);
      if (next) found = next;
    }
    return found;
  } catch {
    return undefined;
  }
}

function intentFromEvent(event: unknown): string | undefined {
  try {
    const e = event as { intent?: unknown; args?: unknown; input?: unknown };
    return intentFromUnknown(e?.intent) ?? intentFromToolArgs(e?.args ?? e?.input);
  } catch {
    return undefined;
  }
}

function setWorking(ctx: unknown, message: string | undefined): void {
  try {
    const c = ctx as { hasUI?: unknown; ui?: { setWorkingMessage?: (m: string | undefined) => void } };
    if (c?.hasUI === true) c.ui?.setWorkingMessage?.(message);
  } catch {
    // No UI or stubbed surface (RPC/ACP/headless): nothing to pulse.
  }
}

// ── v2 shared renderer helpers (same file, no new modules) ──

// Full pre-collapse text stashed by the tool_result handler. Expanded rows
// read it so ctrl+o shows everything; collapsed rows keep the one-liner.

// Frozen per-turn group identity. tool_result stashes these into the persisted
// details while module state is live; renderResult reads them back so rebuilt
// transcripts (restart/resume) regroup rows under their original parent header
// instead of scattering _anon groups with no label.
function frozenGroupKeys(toolName: string): Record<string, unknown> {
  if (!wrapTool(toolName) || activityRunId === null) return {};
  return { minimalGroupRun: activityRunId, minimalGroupLabel: activityLabel };
}

function frozenGroupOf(result: unknown): { gid: string; label: string } | undefined {
  try {
    const d = (result as { details?: unknown } | null | undefined)?.details;
    if (typeof d !== "object" || d === null) return undefined;
    const gid = (d as Record<string, unknown>)["minimalGroupRun"];
    const label = (d as Record<string, unknown>)["minimalGroupLabel"];
    if (typeof gid === "string" && gid && typeof label === "string") return { gid, label };
  } catch {}
  return undefined;
}

function stripLead(line: string): string {
  return line
    .replace(/^\s*◆\s*/, "")
    .replace(/^\$\s+/, "")
    .trim();
}

function displayToolBody(line: string): string {
  const s = stripLead(line);
  if (/^grep\b/i.test(s)) return s.replace(/^grep\b/i, "Search");
  if (/^glob\b/i.test(s)) return s.replace(/^glob\b/i, "Glob");
  return s;
}

function thoughtFadeKey(): string {
  return activityRunId ? `thought:${activityRunId}` : "thought:live";
}

function thinkingRailLines(theme: unknown, width: number, text: string, indent: boolean): string[] {
  if (!text.trim()) return [];
  const pad = indent ? TOOL_INDENT : "  ";
  const bar = `${pad}│ `;
  const innerW = Math.max(8, Math.floor((Math.floor(width) || 0) * LINE_WIDTH_RATIO) - visibleWidth(bar));
  const lines: string[] = [];
  const op = getPluginConfig().opacity;
  for (const preview of wrapLatestLines(text, innerW, THOUGHT_PREVIEW_LINES)) {
    lines.push(`${paintAt(theme, bar, "accent", op)}${paintAt(theme, preview, "toolOutput", op)}`);
  }
  return lines;
}

function paintThinkingVisual(theme: unknown): Container {
  const c = new Container();
  c.addChild({
    render: (width: number): readonly string[] => {
      const live = thoughtLive;
      const body = live ? "Thinking..." : thoughtSettledLabel || "Thought";
      const lines: string[] = [
        formatRowLine(theme, width, {
          body,
          live,
          fadeKey: thoughtFadeKey(),
          right: live && thoughtStartedAt > 0 ? elapsedSuffix(thoughtStartedAt) : "",
        }),
      ];
      if (live) lines.push(...thinkingRailLines(theme, width, thoughtText, false));
      return lines;
    },
  });
  return c;
}

function bindThoughtUi(ctx: unknown): void {
  if (typeof ctx !== "object" || ctx === null || !("ui" in ctx)) return;
  const ui = (ctx as { ui?: typeof thoughtUi }).ui;
  if (ui) thoughtUi = ui;
}

function setThoughtWidget(show: boolean): void {
  const ui = thoughtUi;
  if (!ui || typeof ui.setWidget !== "function") return;
  try {
    if (!show) {
      if (thoughtWidgetOn) ui.setWidget(THOUGHT_WIDGET_KEY, undefined);
      thoughtWidgetOn = false;
      return;
    }
    if (thoughtWidgetOn) {
      if (typeof ui.requestRender === "function") ui.requestRender();
      return;
    }
    ui.setWidget(THOUGHT_WIDGET_KEY, (_tui: unknown, theme: unknown) => paintThinkingVisual(theme), {
      placement: "aboveEditor",
    });
    thoughtWidgetOn = true;
  } catch {
    thoughtWidgetOn = false;
  }
}

function resetThought(): void {
  thoughtLive = false;
  thoughtStartedAt = 0;
  thoughtText = "";
  thoughtSettledLabel = "";
  setThoughtWidget(false);
}

function paintRow(
  theme: unknown,
  opts: {
    body: string | (() => string);
    indent?: boolean;
    live?: boolean;
    error?: boolean;
    right?: string | (() => string);
    fadeKey?: string;
    liveRight?: () => string;
    isLive?: () => boolean;
  },
) {
  const c = new Container();
  const render = (width: number): readonly string[] => {
    const live = opts.isLive ? opts.isLive() : opts.live === true;
    const body = typeof opts.body === "function" ? opts.body() : opts.body;
    const right =
      live && opts.liveRight ? opts.liveRight() : typeof opts.right === "function" ? opts.right() : (opts.right ?? "");
    return [
      formatRowLine(theme, width, {
        body,
        indent: opts.indent,
        live,
        error: opts.error,
        right,
        fadeKey: opts.fadeKey,
      }),
    ];
  };
  c.addChild({ render });
  markFlush?.(c);
  return c;
}

function emptyBlock(): Container {
  const c = new Container();
  c.addChild({ render: (): readonly string[] => [] });
  markFlush?.(c);
  return c;
}

function upsertGroupRow(fp: string, row: Omit<GroupRow, "fp">, frozen?: { gid: string; label: string }): string {
  let gid = frozen?.gid ?? fpToGroup.get(fp);
  if (!gid) {
    gid = activityRunId ?? `_anon:${fp}`;
    fpToGroup.set(fp, gid);
  } else if (frozen?.gid) {
    fpToGroup.set(fp, gid);
  }
  let group = toolGroups.get(gid);
  if (!group) {
    group = { label: frozen?.label ?? activityLabel, rows: new Map() };
    toolGroups.set(gid, group);
  } else if (frozen?.label) {
    if (!group.label) group.label = frozen.label;
  } else if (activityLabel) {
    group.label = activityLabel;
  }
  const prev = group.rows.get(fp);
  group.rows.set(fp, {
    fp,
    body: row.body,
    live: row.live,
    error: row.error,
    right: row.right,
    startedAt: prev?.startedAt ?? row.startedAt,
  });
  if (toolGroups.size > 40) {
    const oldest = toolGroups.keys().next();
    if (!oldest.done && oldest.value !== gid) toolGroups.delete(oldest.value);
  }
  return gid;
}

function isGroupLead(gid: string, fp: string): boolean {
  if (fp.startsWith("thought:")) return false;
  const group = toolGroups.get(gid);
  if (!group) return false;
  for (const key of group.rows.keys()) {
    if (key.startsWith("thought:")) continue;
    return key === fp;
  }
  return false;
}

function rowIsLive(fp: string): boolean {
  if (thoughtLive && fp.startsWith("thought:")) return true;
  for (const value of liveRuns.values()) {
    if (value.fp === fp) return true;
  }
  return false;
}

function paintGroup(theme: unknown, gid: string): Container {
  const c = new Container();
  c.addChild({
    render: (width: number): readonly string[] => {
      const group = toolGroups.get(gid);
      if (!group) return [];
      const lines: string[] = [];
      const anyLive = [...group.rows.values()].some((row) => rowIsLive(row.fp));
      const headerLive = anyLive && activityLive;
      const header = activityRunId === gid && activityLabel ? activityLabel : group.label;
      const rows = [...group.rows.values()].sort((a, b) => a.startedAt - b.startedAt);
      // Multi-read groups keep one row per file under a count header
      // (`● Read 3 files` + tree children); the count lives in the header
      // so no child is merged away.
      const bodies = rows.filter((row) => !row.fp.startsWith("thought:"));
      const readCount = bodies.filter((row) => row.fp.startsWith("read:")).length;
      const headerBody = bodies.length > 1 && readCount === bodies.length ? `Read ${readCount} files` : header;
      if (headerBody.trim()) {
        lines.push(
          formatRowLine(theme, width, {
            body: headerBody,
            live: headerLive,
            fadeKey: `act:${gid}`,
            right: headerLive ? elapsedSuffix(activityStartedAt) : "",
            mark: headerLive ? undefined : "●",
          }),
        );
      }
      for (const [idx, row] of rows.entries()) {
        const live = rowIsLive(row.fp);
        const isThought = row.fp.startsWith("thought:");
        lines.push(
          formatRowLine(theme, width, {
            body: row.body,
            indent: true,
            tree: idx === rows.length - 1 ? "last" : "mid",
            live,
            error: row.error,
            fadeKey: row.fp,
            right: live ? (isThought ? "" : elapsedSuffix(row.startedAt)) : row.right,
          }),
        );
        if (isThought && row.live) {
          lines.push(...thinkingRailLines(theme, width, thoughtText, true));
        }
      }
      return lines;
    },
  });
  markFlush?.(c);
  return c;
}

// Core inserts a blank line between every tool block. Paint the whole nested
// group inside the lead tool and return an empty framed block for siblings.
function renderToolVisual(
  theme: unknown,
  fp: string,
  opts: { body: string; live: boolean; error: boolean; right?: string },
  frozen?: { gid: string; label: string },
): Container {
  const gid = upsertGroupRow(
    fp,
    {
      body: opts.body,
      live: opts.live,
      error: opts.error,
      right: opts.right ?? "",
      startedAt: Date.now(),
    },
    frozen,
  );
  if (!isGroupLead(gid, fp)) return emptyBlock();
  return paintGroup(theme, gid);
}

type ActivityDetails = { kind?: unknown; label?: unknown; startedAt?: unknown; total?: unknown; runId?: unknown };

function activityDetailsOf(message: unknown):
  | {
      kind: string;
      label: string;
      startedAt: number;
      total: number;
      runId: string;
    }
  | undefined {
  try {
    const details = ((message as { details?: unknown })?.details ?? {}) as ActivityDetails;
    if (typeof details.label !== "string" || !details.label) return undefined;
    return {
      kind: details.kind === "settled" ? "settled" : "live",
      label: details.label,
      startedAt: typeof details.startedAt === "number" && Number.isFinite(details.startedAt) ? details.startedAt : 0,
      total:
        typeof details.total === "number" && Number.isFinite(details.total) && details.total >= 0
          ? Math.floor(details.total)
          : 0,
      runId: typeof details.runId === "string" ? details.runId : "",
    };
  } catch {
    return undefined;
  }
}

function activityStaleTail(startedAt: number): string {
  if (!(startedAt > 0)) return " (…)";
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (elapsed > 3600) return " (…)";
  return ` (${elapsed}s)`;
}

// Mirror rows read frozen message details first: settled records are pure
// functions of their own payload, so rebuilds and resumed sessions can never
// show a later run's label. Only the current turn's live row follows shared
// module state (animated frame + latest label + burst elapsed on the 120ms
// pump repaints); anything retired freezes via the settled-totals map.
function activityRenderer(_message: unknown, _options: unknown, theme: unknown) {
  const d = activityDetailsOf(_message);
  if (!d) return new Container();
  if (d.kind === "settled") {
    return paintRow(theme, { body: d.label, right: ` (${d.total}s)` });
  }
  if (d.runId !== "" && d.runId === activityRunId && activityLive) {
    const runId = d.runId;
    const frozenRight = () => {
      const frozen = activitySettledTotals.get(runId);
      if (frozen !== undefined) return ` (${frozen.total}s)`;
      return activityStaleTail(d.startedAt);
    };
    return paintRow(theme, {
      body: () => {
        if (runId === activityRunId && activityLive) return activityLabel || d.label;
        return activitySettledTotals.get(runId)?.label || d.label;
      },
      live: true,
      fadeKey: `act:${runId}`,
      isLive: () => runId === activityRunId && activityLive,
      liveRight: () => elapsedSuffix(activityStartedAt > 0 ? activityStartedAt : d.startedAt),
      right: frozenRight,
    });
  }
  const frozen = d.runId ? activitySettledTotals.get(d.runId) : undefined;
  if (frozen !== undefined) {
    return paintRow(theme, {
      body: frozen.label || activityLabel || d.label,
      right: ` (${frozen.total}s)`,
    });
  }
  return paintRow(theme, {
    body: d.label,
    right: activityStaleTail(d.startedAt),
  });
}

// Managed-timer probe: timer fns live on the handler ctx alongside ui/hasUI
// (non-enumerable on some surfaces), so feature-detect instead of assuming shape.
function pulseTimers(
  ctx: unknown,
): { setInterval: (fn: () => void, ms: number) => unknown; clearTimer: (h: unknown) => void } | undefined {
  if (typeof ctx !== "object" || ctx === null) return undefined;
  if (!("setInterval" in ctx) || !("clearTimer" in ctx)) return undefined;
  const every = ctx.setInterval;
  const clear = ctx.clearTimer;
  if (typeof every !== "function" || typeof clear !== "function") return undefined;
  // Reason: handler ctx is structurally typed upstream; call through unknown fn values.
  const setEvery = every as (fn: () => void, ms: number) => unknown;
  const clearOne = clear as (h: unknown) => void;
  return {
    setInterval: (fn, ms) => setEvery(fn, ms),
    clearTimer: (h) => clearOne(h),
  };
}

function skillPromptOf(message: unknown): { name: string; args: string; userInvoked: boolean } {
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

function skillPromptBody(message: unknown): string {
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

function skillPromptRenderer(message: unknown, options: unknown, theme: unknown) {
  const m = (message ?? {}) as Record<string, unknown>;
  if (m["display"] === false) return new Container();
  const opts = (options ?? {}) as Record<string, unknown>;
  const { name, args, userInvoked } = skillPromptOf(message);
  if (opts["expanded"] === true) {
    const body = skillPromptBody(message);
    if (!body) return new Container();
    return paintRow(theme, { body });
  }
  const oneLiner = userInvoked && args ? `◆ Skill ${name} ${args}` : `◆ Skill ${name}`;
  return paintRow(theme, { body: oneLiner });
}

export default function (pi: ExtensionAPI) {
  let readGroupTheme: unknown;
  // Native grouped reads (ReadToolGroupComponent) bypass the wrapped-read
  // renderers; skin them at addChild time so transcript rebuilds and live
  // grouping repaint through formatRowLine. Before any pi.on registration:
  // a rebuild can add the group before session_start fires.
  installReadGroupSkin(Container, {
    enabled: () => enabled && wrapTool("read"),
    theme: () => readGroupTheme,
  });
  let loaded = false;
  let spinTimer: unknown = undefined;
  let spinUi: unknown;
  pi.registerMessageRenderer("minimal-activity", (message, options, theme) =>
    activityRenderer(message, options, theme),
  );
  pi.registerMessageRenderer("skill-prompt", (message, options, theme) => skillPromptRenderer(message, options, theme));
  // Aside-channel records: the only extension path that paints transcript
  // rows. Non-interrupting by core design (step-boundary pickup, never
  // steers the run), triggerTurn false, empty content, hidden from the
  // queue UI. Async failures surface once through core's error toast;
  // a missing API (older host) disables sends silently — rows still work.
  const sendActivityRecord = (details: Record<string, unknown>): void => {
    if (!enabled || activityApiDead) return;
    try {
      pi.sendMessage(
        { customType: "minimal-activity", content: "", display: true, details },
        { triggerTurn: false, deliverAs: "aside" },
      );
    } catch {
      activityApiDead = true;
    }
  };
  const rememberSettledTotal = (runId: string, total: number, label: string): void => {
    activitySettledTotals.set(runId, { total, label });
    if (activitySettledTotals.size > 100) {
      const oldest = activitySettledTotals.keys().next();
      if (!oldest.done) activitySettledTotals.delete(oldest.value);
    }
  };
  const freezeActivityRun = (): void => {
    if (activityRunId !== null && !activitySettledTotals.has(activityRunId)) {
      const base = activityStartedAt > 0 ? activityStartedAt : Date.now();
      rememberSettledTotal(activityRunId, Math.max(0, Math.floor((Date.now() - base) / 1000)), activityLabel);
    }
  };
  const applyIntent = (text: string, startedAt: number): void => {
    if (!text) return;
    if (activityRunId !== null && text === activityLabel) {
      activityLive = true;
      return;
    }
    // Several tools share one status row. While any tool in the group is
    // live, keep the parent and (optionally) refresh its label in place.
    if (activityRunId !== null && liveRuns.size > 0) {
      activityLabel = text;
      activityLive = true;
      return;
    }
    if (activityRunId !== null && activityLabel) {
      freezeActivityRun();
      activityRunId = `${activityProcessTag}-${activityRunSeq++}`;
      activityLiveSent = false;
      activityLeadFp = "";
    }
    activityLabel = text;
    if (activityRunId === null) activityRunId = `${activityProcessTag}-${activityRunSeq++}`;
    activityStartedAt = startedAt;
    if (!activityLiveSent) {
      activityLiveSent = true;
      textFades.set(`act:${activityRunId}`, Date.now());
    }
    activityLive = true;
  };
  // Row animation pump. Core only ticks spinner frames for its own
  // renderers, so custom rows animate themselves: one managed 120ms timer
  // advances the shared frame, repaints, and mirrors the latest label to
  // the working line. Row components read the frame at render time, so
  // every repaint cycles them without re-invoking renderers.
  function ensureSpinTimer(ctx: unknown): void {
    bindThoughtUi(ctx);
    if (typeof ctx === "object" && ctx !== null && "ui" in ctx) {
      const ui = ctx.ui;
      if (typeof ui === "object" && ui !== null && "requestRender" in ui) {
        spinUi = ui;
      }
    }
    if (spinTimer !== undefined) return;
    const timers = pulseTimers(ctx);
    if (!timers) return;
    try {
      spinTimer = timers.setInterval(() => {
        advanceSpinFrame();
        maybeReloadConfig();
        const pump = spinUi;
        if (typeof pump === "object" && pump !== null && "requestRender" in pump) {
          const paint = pump.requestRender;
          // Reason: narrowed to a callable via typeof; signature cast only.
          if (typeof paint === "function") {
            try {
              (paint as () => void)();
            } catch {
              // Repaint is best-effort; the next tick retries.
            }
          }
        }
      }, 120);
    } catch {
      spinTimer = undefined;
    }
  }
  // Best-effort repaint for hosts where the 120ms pump never starts (no
  // managed timers on ctx): without this, a pending card painted before the
  // label lands stays headerless until the settle repaint. Core coalesces
  // frames, so one extra request per tool start is cheap.
  function requestRepaint(): void {
    try {
      const pump = spinUi;
      if (typeof pump === "object" && pump !== null && "requestRender" in pump) {
        const paint = pump.requestRender;
        if (typeof paint === "function") {
          (paint as () => void)();
        }
      }
    } catch {
      // Repaint is best-effort; the next event or tick retries.
    }
  }

  function extractThinking(message: unknown): { text: string; live: boolean } {
    try {
      const content = (message as { content?: unknown })?.content;
      if (!Array.isArray(content)) return { text: "", live: false };
      let text = "";
      let lastIsThinking = false;
      for (const item of content as Array<{ type?: unknown; thinking?: unknown; text?: unknown }>) {
        const kind = item?.type;
        if (kind === "thinking" || kind === "reasoning" || kind === "redactedThinking") {
          const chunk =
            typeof item.thinking === "string" ? item.thinking : typeof item.text === "string" ? item.text : "";
          if (chunk) text = chunk;
          lastIsThinking = true;
        } else if (kind === "text" || kind === "toolCall") {
          lastIsThinking = false;
        }
      }
      return { text, live: lastIsThinking };
    } catch {
      return { text: "", live: false };
    }
  }
  function syncThought(): void {
    if (!activityRunId) return;
    const fp = `thought:${activityRunId}`;
    if (thoughtLive) {
      if (thoughtStartedAt === 0) thoughtStartedAt = Date.now();
      thoughtSettledLabel = "";
      upsertGroupRow(fp, {
        body: "Thinking...",
        live: true,
        error: false,
        right: "",
        startedAt: thoughtStartedAt,
      });
      return;
    }
    if (thoughtStartedAt > 0) {
      const sec = Math.max(0, Math.floor((Date.now() - thoughtStartedAt) / 1000));
      thoughtSettledLabel = sec > 0 ? `Thought for ${sec}s` : "Thought";
      upsertGroupRow(fp, {
        body: "Thought",
        live: false,
        error: false,
        right: sec > 0 ? ` (${sec}s)` : "",
        startedAt: thoughtStartedAt,
      });
      markSettling(fp);
      thoughtStartedAt = 0;
    }
  }

  function tryWrapTool(name: string, source?: unknown): void {
    if (!name || wrapApplied.has(name)) return;
    // One-liners for bash/read/grep/glob/write plus the edit pretty-diff
    // card and the eval output card. Execution delegates untouched to
    // native; only the card is custom (compact rows, full text behind Ctrl+O).
    if (!wrapTool(name)) return;
    const src = typeof source === "object" && source !== null ? (source as Record<string, unknown>) : {};
    // NEVER register a lossy stub: without the native parameters the shadowed
    // schema hides fields from the model (write lost `content`, grep lost `path`).
    // Skip instead — native rendering is the safe degradation.
    if (src["parameters"] == null) return;
    wrapApplied.add(name);
    const description = typeof src["description"] === "string" ? src["description"] : name;
    const parameters = src["parameters"];
    try {
      pi.registerTool({
        name,
        description,
        parameters: parameters as never,
        mergeCallAndResult: true,
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          const c = ctx as unknown as {
            invokeTool?: (
              p: Record<string, unknown>,
              o?: { signal?: AbortSignal; onUpdate?: unknown },
            ) => Promise<unknown>;
          };
          if (typeof c?.invokeTool !== "function") {
            throw new Error(`minimal-output: native ${name} unavailable`);
          }
          return (await c.invokeTool(params as Record<string, unknown>, {
            signal: signal as AbortSignal,
            onUpdate: onUpdate as unknown,
          })) as never;
        },
        renderCall(args, options, theme) {
          const partial = (options as { isPartial?: boolean })?.isPartial === true;
          if (name === "edit") return renderPrettyEditCard(theme, args, undefined, options, partial);
          if (name === "eval") return renderEvalCard(theme, args, undefined, options, partial, toolFingerprint(name, args));
          return renderToolVisual(theme, toolFingerprint(name, args), {
            body: toolActionLabel(name, args),
            live: partial,
            error: false,
          });
        },
        renderResult(result, options, theme, args) {
          if (name === "edit") return renderPrettyEditCard(theme, args, result, options, false);
          if (name === "eval") return renderEvalCard(theme, args, result, options, false, toolFingerprint(name, args));
          return renderToolVisual(
            theme,
            toolFingerprint(name, args),
            {
              body: toolActionLabel(name, args),
              live: false,
              error: isToolError(result, options),
              right: durationSuffix(result),
            },
            frozenGroupOf(result),
          );
        },
      });
    } catch {
      // Already registered or host rejected the wrap.
    }
  }
  function wrapAllTools(): void {
    const api = pi as unknown as { getAllTools?: () => unknown };
    if (typeof api.getAllTools !== "function") return;
    try {
      const tools = api.getAllTools();
      if (!Array.isArray(tools)) return;
      for (const tool of tools) {
        const name =
          typeof tool === "string"
            ? tool
            : typeof tool === "object" &&
                tool !== null &&
                "name" in tool &&
                typeof (tool as { name: unknown }).name === "string"
              ? (tool as { name: string }).name
              : "";
        if (name) tryWrapTool(name, tool);
      }
    } catch {
      // Registry not ready.
    }
  }
  function stopSpinTimerIfIdle(ctx: unknown): void {
    if (activityLive || thoughtLive || liveRuns.size !== 0 || anySettling() || spinTimer === undefined) return;
    try {
      pulseTimers(ctx)?.clearTimer(spinTimer);
    } catch {
      // Clear is best-effort; the managed timer dies with the session regardless.
    }
    spinTimer = undefined;
    const pump = spinUi;
    if (typeof pump === "object" && pump !== null && "requestRender" in pump) {
      const paint = pump.requestRender;
      if (typeof paint === "function") {
        try {
          (paint as () => void)();
        } catch {
          // Repaint is best-effort; the settled line paints on the next render.
        }
      }
    }
  }
  pi.on("session_start", async (_event, ctx) => {
    if (loaded) return;
    loaded = true;
    reloadPluginConfig();
    try {
      lastConfigMtimes = configMtimeKey();
    } catch {
      // Missing lockfile; timer establishes the baseline.
    }
    bindThoughtUi(ctx);
    try {
      const maybeTheme = (ctx as unknown as { ui?: { theme?: unknown } })?.ui?.theme;
      if (maybeTheme !== undefined) readGroupTheme = maybeTheme;
    } catch {
      // formatRowLine degrades to unstyled without a theme.
    }
    wrapAllTools();
    try {
      if (enabled && ctx.hasUI) ctx.ui.notify("Minimal output active (grok-build style)", "info");
    } catch {
      // notify is best-effort chrome.
    }
  });
  pi.on("before_agent_start", async () => {
    reloadPluginConfig();
    try {
      lastConfigMtimes = configMtimeKey();
    } catch {
      // Missing lockfile; timer establishes the baseline.
    }
    wrapAllTools();
  });

  pi.on("tool_result", async (event, _ctx) => {
    try {
      if (!enabled) return undefined;
      const prevDetails = "details" in event ? event.details : undefined;
      const frozen = frozenGroupKeys(event.toolName);
      const withFrozen = (details: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
        if (Object.keys(frozen).length === 0) return details;
        return { ...(details ?? {}), ...frozen };
      };
      const lead =
        eventFingerprint(event) === activityLeadFp && activityLabel
          ? { minimalActivityLead: true, minimalActivityLabel: activityLabel }
          : undefined;
      const withLead = (details: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
        if (!lead) return details;
        return { ...(details ?? {}), ...lead };
      };
      if (!isCollapseTarget(event)) {
        if (!lead) return undefined;
        return { details: withLead(withFrozen(stashFullText(prevDetails, ""))) };
      }
      const found = textItemOf(event.content);
      if (!found) {
        if (!lead) return undefined;
        return { details: withLead(withFrozen(stashFullText(prevDetails, ""))) };
      }
      const original = found.item.text as string;
      const isMcp = event.toolName.startsWith("mcp__") || event.toolName.includes("/");
      const raw = isMcp ? (unwrapResultEnvelope(original) ?? original) : original;
      const result = collapseToolText(event.toolName, event.input, raw);
      const pruned = isMcp ? pruneMcpEnvelopes(found.list, found.item, raw) : found.list;
      const droppedDupes = pruned.length !== found.list.length;
      if (!result.changed && !droppedDupes && !lead) return undefined;
      let finalText = result.changed ? result.text : original;
      if (result.changed && result.rule.split(",").includes("truncate")) {
        const path = await spillToolOutput(event.toolName, raw);
        finalText += `\n[Output truncated: ${raw.length}→${result.text.length} chars, rule=${result.rule}. Full output: ${path ?? "spill failed"}]`;
      }
      // Stash the raw text (ANSI intact): the eval card reads it back so its
      // output keeps TTY colors; the collapsed message text stays stripped.
      const details = withLead(withFrozen(stashFullText(prevDetails, raw)));
      if (!result.changed && !droppedDupes) return { details };
      return {
        content: pruned.map((c) => (c === found.item ? { ...c, text: finalText } : c)),
        details,
      };
    } catch {
      return undefined;
    }
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!enabled) return;
    const startedAt = Date.now();
    const fp = eventFingerprint(event);
    const toolName =
      typeof (event as { toolName?: unknown }).toolName === "string"
        ? (event as { toolName: string }).toolName
        : "tool";
    const args = (event as { input?: unknown; args?: unknown }).input ?? (event as { args?: unknown }).args;
    liveRuns.set(event.toolCallId, {
      label: intentFromEvent(event) ?? activityLabel,
      startedAt,
      fp,
    });
    if (liveRuns.size === 1) {
      spinStartedAt = startedAt;
      activityLeadFp = fp;
    }
    activityTotal = "";
    if (activityRunId === null) {
      const intent = intentFromEvent(event) ?? summarizeEvent(event);
      applyIntent(intent, startedAt);
    } else {
      activityLive = true;
    }
    if (toolName !== "edit" && toolName !== "eval") {
      upsertGroupRow(fp, {
        body: toolActionLabel(toolName, args),
        live: true,
        error: false,
        right: "",
        startedAt,
      });
    }
    tryWrapTool(toolName);
    ensureSpinTimer(ctx);
    setThoughtWidget(false);
    requestRepaint();
  });

  pi.on("tool_execution_end", async (event, _ctx) => {
    if (!enabled) return;
    const ended = liveRuns.get(event.toolCallId);
    liveRuns.delete(event.toolCallId);
    if (ended) markSettling(ended.fp);
    if (liveRuns.size === 0) {
      const base = activityStartedAt > 0 ? activityStartedAt : Date.now();
      const total = Math.max(0, Math.floor((Date.now() - base) / 1000));
      activityTotal = ` (${total}s)`;
      if (activityRunId !== null) {
        rememberSettledTotal(activityRunId, total, activityLabel);
        markSettling(`act:${activityRunId}`);
      }
      spinStartedAt = 0;
    } else {
      let earliest = Number.POSITIVE_INFINITY;
      for (const value of liveRuns.values()) earliest = Math.min(earliest, value.startedAt);
      spinStartedAt = earliest;
    }
  });

  pi.on("message_update", async (event, ctx) => {
    if (!enabled) return;
    bindThoughtUi(ctx);
    const prevRun = activityRunId;
    const prevLabel = activityLabel;
    const next = intentFromAssistantMessage(event.message);
    if (next) {
      applyIntent(next, Date.now());
      ensureSpinTimer(ctx);
    }
    const thinking = extractThinking(event.message);
    if (thinking.text) thoughtText = thinking.text;
    if (thinking.live) {
      thoughtLive = true;
      if (!activityRunId) applyIntent(activityLabel || "Working", Date.now());
      syncThought();
      setThoughtWidget(liveRuns.size === 0);
      ensureSpinTimer(ctx);
    } else if (thoughtLive) {
      thoughtLive = false;
      syncThought();
      setThoughtWidget(liveRuns.size === 0 && thoughtSettledLabel !== "");
    } else if (thoughtWidgetOn) {
      setThoughtWidget(true);
    }
    if (activityRunId !== prevRun || activityLabel !== prevLabel) requestRepaint();
  });

  pi.on("agent_end", async (_event, ctx) => {
    liveRuns.clear();
    freezeActivityRun();
    spinStartedAt = 0;
    activityStartedAt = 0;
    activityLabel = "";
    activityLive = false;
    activityTotal = "";
    activityRunId = null;
    activityLiveSent = false;
    activityLeadFp = "";
    resetThought();
    stopSpinTimerIfIdle(ctx);
    setWorking(ctx, undefined);
  });

  pi.on("turn_end", async (_event, ctx) => {
    liveRuns.clear();
    freezeActivityRun();
    spinStartedAt = 0;
    activityStartedAt = 0;
    activityLabel = "";
    activityLive = false;
    activityTotal = "";
    activityRunId = null;
    activityLiveSent = false;
    activityLeadFp = "";
    resetThought();
    stopSpinTimerIfIdle(ctx);
    setWorking(ctx, undefined);
  });

  pi.registerCommand("minimal-on", {
    description: "Enable grok-build-style minimal output",
    handler: async (_args, ctx) => {
      enabled = true;
      activityRunId = null;
      activityLiveSent = false;
      ctx.ui.notify("Minimal output enabled", "info");
    },
  });

  pi.registerCommand("minimal-off", {
    description: "Disable grok-build-style minimal output",
    handler: async (_args, ctx) => {
      enabled = false;
      liveRuns.clear();
      freezeActivityRun();
      spinStartedAt = 0;
      activityStartedAt = 0;
      activityLabel = "";
      activityLive = false;
      activityTotal = "";
      activityRunId = null;
      activityLiveSent = false;
      activityLeadFp = "";
      resetThought();
      stopSpinTimerIfIdle(ctx);
      setWorking(ctx, undefined);
      ctx.ui.notify("Minimal output disabled", "warning");
    },
  });

  if (typeof (pi as { registerAssistantThinkingRenderer?: unknown }).registerAssistantThinkingRenderer === "function") {
    try {
      (
        pi as {
          registerAssistantThinkingRenderer: (fn: (...a: unknown[]) => unknown) => void;
        }
      ).registerAssistantThinkingRenderer(() => {
        // Host addChild()s the return value and later calls .render().
        // `{ component, mode: "replace" }` is not a Component, so Ctrl+T
        // (unhide thinking) crashed with "t[i].render is not a function".
        return undefined;
      });
    } catch {
      // Older hosts without this hook keep hideThinkingBlock + the widget path.
    }
  }

  pi.registerCommand("minimal-status", {
    description: "Show minimal-output plugin state",
    handler: async (_args, ctx) => {
      const cfg = getPluginConfig();
      const native: string[] = [];
      if (cfg.nativeBash) native.push("bash");
      if (cfg.nativeRead) native.push("read");
      if (cfg.nativeGrep) native.push("grep");
      if (cfg.nativeGlob) native.push("glob");
      if (cfg.nativeWrite) native.push("write");
      if (cfg.nativeEdit) native.push("edit");
      if (cfg.nativeEval) native.push("eval");
      ctx.ui.notify(
        `Minimal output: ${enabled ? "on" : "off"} (collapsed rows, shimmer disabled) opacity=${cfg.opacity} indicator=${cfg.indicator} anim=${cfg.indicatorAnimation ? "on" : "off"} native=[${native.join(",")}] tabs=${cfg.editShowTabs ? "on" : "off"} spaces=${cfg.editShowSpaces ? "on" : "off"}`,
        "info",
      );
    },
  });
}

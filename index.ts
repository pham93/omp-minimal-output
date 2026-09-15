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
  isWrappedTool,
  lockfilePath,
  projectOverridePaths,
  reloadPluginConfig,
  type WrappedTool,
  WRAPPED_TOOL_REGISTRY,
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
import { renderWebSearchCard } from "./web-search-card.ts";
import { cardIsPartial, resultDetails } from "./card-primitives.ts";
import { installReadGroupSkin } from "./read-group.ts";
import { commentaryStatusFromMessage, installAssistantCommentarySkin } from "./assistant-commentary-skin.ts";
import {
  installNativeToolCardSkin,
  nativeToolCardsNeedPump,
  resetNativeToolCardPump,
} from "./native-tool-card-skin.ts";
import { alertSkinActive, installWarningSkin, invalidateLiveAlerts } from "./warning-skin.ts";
import { installTodoChrome } from "./todo-hud.ts";
import { acquireRuntimeOwner } from "./runtime-owner.ts";
import {
  latestTodoDetailsFromEntries,
  parseTodoPhases,
  parseTodoResult,
  renderTodoHeader,
  todoItemKey,
  todoNeedsPump,
  type TodoHeaderState,
} from "./todos-header.ts";

interface ToolCardRenderer {
  renderCall(
    theme: unknown,
    args: unknown,
    options: unknown,
    fingerprint: string,
    parentLabel: () => string,
  ): Container;
  renderResult(
    theme: unknown,
    args: unknown,
    result: unknown,
    options: unknown,
    fingerprint: string,
    parentLabel: () => string,
  ): Container;
}

const CARD_RENDERERS = {
  edit: {
    renderCall(theme, args, options, _fingerprint, parentLabel) {
      return renderPrettyEditCard(theme, args, undefined, options, cardIsPartial(options), parentLabel);
    },
    renderResult(theme, args, result, options, _fingerprint, parentLabel) {
      return renderPrettyEditCard(theme, args, result, options, false, parentLabel);
    },
  },
  eval: {
    renderCall(theme, args, options, fingerprint, parentLabel) {
      return renderEvalCard(theme, args, undefined, options, cardIsPartial(options), fingerprint, parentLabel);
    },
    renderResult(theme, args, result, options, fingerprint, parentLabel) {
      return renderEvalCard(theme, args, result, options, false, fingerprint, parentLabel);
    },
  },
  web_search: {
    renderCall(theme, args, options, fingerprint, parentLabel) {
      return renderWebSearchCard(theme, args, undefined, options, fingerprint, parentLabel);
    },
    renderResult(theme, args, result, options, fingerprint, parentLabel) {
      return renderWebSearchCard(theme, args, result, options, fingerprint, parentLabel);
    },
  },
} satisfies Partial<Record<WrappedTool, ToolCardRenderer>>;

const ACTIVITY_LABEL_SOURCE = {
  generated: "generated",
  tool: "tool",
  commentary: "commentary",
} as const;

type ActivityLabelSource = (typeof ACTIVITY_LABEL_SOURCE)[keyof typeof ACTIVITY_LABEL_SOURCE];

const ACTIVITY_LABEL_RANK = {
  [ACTIVITY_LABEL_SOURCE.generated]: 0,
  [ACTIVITY_LABEL_SOURCE.tool]: 1,
  [ACTIVITY_LABEL_SOURCE.commentary]: 2,
} as const satisfies Record<ActivityLabelSource, number>;

// Elapsed base for the live row timer (ms epoch). Maintained by the
// tool handlers below; renderers only read it.
let spinStartedAt = 0;
let activityStartedAt = 0;
let activityLabel = "";
let activityLive = false;
let activityLabelSource: ActivityLabelSource = ACTIVITY_LABEL_SOURCE.generated;
// Per-turn mirror identity for the aside-channel records below. The live row
// is sent once per turn; a settled record goes out on every tool drain.
// Renderer state freezes in message details so old rows never mirror a later run.
let activityRunId: string | null = null;
let activityLiveSent = false;
let activityContext = "";
let activitySettledSent = false;
let activityApiDead = false;
const activityProcessTag = Math.floor(Math.random() * 36 ** 6).toString(36);
let activityRunSeq = 0;
const liveRuns = new Map<string, { label: string; startedAt: number; fp: string }>();
let activityLeadFp = "";

function parentLabelForCard(fingerprint: string, result?: unknown): string {
  const details = resultDetails(result);
  const persisted = details?.["minimalActivityLabel"];
  if (details?.["minimalActivityLead"] === true && typeof persisted === "string") {
    const label = persisted.trim();
    if (label) return label;
  }
  return fingerprint === activityLeadFp ? activityLabel : "";
}
function parentLabelForToolCall(toolCallId: string, fingerprint: string, result?: unknown): string {
  const persisted = parentLabelForCard(fingerprint, result);
  if (persisted) return persisted;
  const live = liveRuns.get(toolCallId);
  return live?.fp === activityLeadFp ? live.label : "";
}

function toolOwnsParentCard(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized in CARD_RENDERERS || normalized === "task" || normalized === "hub";
}
let enabled = true;
let runtimeIsActive = (): boolean => true;
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
let todosCollapsed = true;
let todoHeaderState: TodoHeaderState | null = null;
const todoCompletingAt = new Map<string, number>();
const todoSeen = new Map<string, string>();
let agentRunning = false;
let kickTodoPump = (): void => {};
let todosUi:
  | {
      setWidget?: (key: string, content: unknown, options?: { placement?: string }) => void;
      requestRender?: () => void;
    }
  | undefined;
let todosWidgetOn = false;
const TODOS_WIDGET_KEY = "minimal-todos";
const THOUGHT_PREVIEW_LINES = 3;
const THOUGHT_WIDGET_KEY = "minimal-thinking";
// Tools already re-registered custom card. wrapTool() config.ts decides
// membership from WRAPPED_TOOL_REGISTRY minus native opt-outs.
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

function todoRawText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content as { type?: unknown; text?: unknown }[]) {
    if (c && typeof c === "object" && c.type === "text" && typeof c.text === "string") parts.push(c.text);
  }
  return parts.join("\n");
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

function nativeToolCardSkinActive(toolName: string): boolean {
  if (!enabled) return false;
  const cfg = getPluginConfig();
  return (toolName === "task" && cfg.nativeTask !== true) || (toolName === "hub" && cfg.nativeHub !== true);
}

function isCollapseTarget(event: ToolResultEvent): boolean {
  if (event.toolName === "web_search" && !wrapTool("web_search")) return false;
  if ((event.toolName === "task" || event.toolName === "hub") && !nativeToolCardSkinActive(event.toolName)) {
    return false;
  }
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
      if (!runtimeIsActive()) return [];
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
  if (!runtimeIsActive() || typeof ctx !== "object" || ctx === null || !("ui" in ctx)) return;
  const ui = (ctx as { ui?: typeof thoughtUi }).ui;
  if (ui) thoughtUi = ui;
}

function setThoughtWidget(show: boolean): void {
  const ui = thoughtUi;
  if (!ui || typeof ui.setWidget !== "function") return;
  try {
    if (!show) {
      ui.setWidget(THOUGHT_WIDGET_KEY, undefined);
      thoughtWidgetOn = false;
      return;
    }
    if (!runtimeIsActive()) return;
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

function bindTodosUi(ctx: unknown): void {
  if (!runtimeIsActive() || typeof ctx !== "object" || ctx === null || !("ui" in ctx)) return;
  const ui = (ctx as { ui?: typeof todosUi }).ui;
  if (ui) todosUi = ui;
}

function paintTodosWidget(theme: unknown): Container {
  const c = new Container();
  c.addChild({
    render: (width: number): readonly string[] => {
      if (!runtimeIsActive()) return [];
      let show = true;
      try {
        show = getPluginConfig().todosHeader !== false;
      } catch {
        // Config read is best-effort; paint with cached state.
      }
      const state = peekTodoState();
      if (!show || !state || state.items.length === 0) return [];
      return renderTodoHeader(theme, width, state, todosCollapsed, todoAnim());
    },
  });
  return c;
}

function setTodosWidget(show: boolean): void {
  const ui = todosUi;
  if (!ui || typeof ui.setWidget !== "function") return;
  try {
    if (!show) {
      ui.setWidget(TODOS_WIDGET_KEY, undefined);
      todosWidgetOn = false;
      return;
    }
    if (!runtimeIsActive()) return;
    if (todosWidgetOn) {
      if (typeof ui.requestRender === "function") ui.requestRender();
      return;
    }
    ui.setWidget(TODOS_WIDGET_KEY, (_tui: unknown, theme: unknown) => paintTodosWidget(theme), {
      placement: "aboveEditor",
    });
    todosWidgetOn = true;
  } catch {
    todosWidgetOn = false;
  }
}

function installTodosWidget(): void {
  let show = true;
  try {
    show = getPluginConfig().todosHeader !== false;
  } catch {
    // Config reload is best-effort; install with the cached state.
  }
  setTodosWidget(show && !!todoHeaderState && todoHeaderState.items.length > 0);
}

function refreshTodosWidget(): void {
  if (!todosWidgetOn) installTodosWidget();
  else setTodosWidget(true);
}
let todoHeaderSig = "";
let todoSource: (() => { phases: unknown } | undefined) | undefined;
let todoSessionVisible = false;

function resetTodoSessionState(): void {
  todoSource = undefined;
  todosCollapsed = true;
  todoSessionVisible = false;
  todoHeaderSig = "";
  todoHeaderState = null;
  todoSeen.clear();
  todoCompletingAt.clear();
  setTodosWidget(false);
}

function bindTodoSource(ctx: unknown): void {
  if (typeof ctx !== "object" || ctx === null) return;
  const rec = ctx as {
    session?: { getTodoPhases?: () => unknown };
    sessionManager?: { getBranch?: () => unknown; getEntries?: () => unknown };
  };
  const session = rec.session;
  const sm = rec.sessionManager;
  if (!session && !sm) return;
  todoSource = () => {
    try {
      const phases = session?.getTodoPhases?.();
      if (Array.isArray(phases)) return { phases };
    } catch {
      // Session getter is best-effort.
    }
    try {
      const entries = typeof sm?.getBranch === "function" ? sm.getBranch() : sm?.getEntries?.();
      return latestTodoDetailsFromEntries(entries);
    } catch {
      return undefined;
    }
  };
}

function todoAnim(): { now: number; completingAt: Map<string, number>; running: boolean } {
  return { now: Date.now(), completingAt: todoCompletingAt, running: agentRunning };
}

function noteTodoTransitions(next: TodoHeaderState): void {
  const live = new Set<string>();
  for (const item of next.items) {
    const key = todoItemKey(item);
    live.add(key);
    const prev = todoSeen.get(key);
    if (item.status === "done" && prev !== undefined && prev !== "done" && !todoCompletingAt.has(key)) {
      todoCompletingAt.set(key, Date.now());
    }
    todoSeen.set(key, item.status);
  }
  for (const key of [...todoSeen.keys()]) {
    if (!live.has(key)) {
      todoSeen.delete(key);
      todoCompletingAt.delete(key);
    }
  }
}

function applyTodoState(next: TodoHeaderState): void {
  noteTodoTransitions(next);
  const sig = JSON.stringify(next.items);
  const hide = next.items.length === 0;
  if (sig === todoHeaderSig && hide === (todoHeaderState === null)) {
    kickTodoPump();
    return;
  }
  todoHeaderSig = sig;
  todoHeaderState = hide ? null : next;
  installTodosWidget();
  refreshTodosWidget();
  kickTodoPump();
}

function peekTodoState(): TodoHeaderState | null {
  if (!todoSessionVisible) return null;
  try {
    const raw = todoSource?.();
    if (raw) {
      const next = parseTodoPhases(raw);
      if (next) {
        noteTodoTransitions(next);
        todoHeaderSig = JSON.stringify(next.items);
        todoHeaderState = next.items.length > 0 ? next : null;
      }
    }
  } catch {
    // Keep last cache.
  }
  kickTodoPump();
  return todoHeaderState;
}

// /todo and foreign writers never emit tool_result. Bind session getters
// when ctx is present; paint-time peek plus HUD addChild keep the widget live.
function syncTodoHeaderFromSession(ctx?: unknown): void {
  if (ctx) bindTodoSource(ctx);
  try {
    if (!todoSessionVisible) return;
    const raw = todoSource?.();
    const next = raw ? parseTodoPhases(raw) : null;
    if (next) applyTodoState(next);
  } catch {
    // History scan is best-effort; the tool_result path still feeds the header.
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

function toolUsesGroupedStatus(toolName: string): boolean {
  if (!wrapApplied.has(toolName)) return false;
  return CARD_RENDERERS[toolName as WrappedTool] === undefined;
}

const ACTIVITY_RECORD_KIND = {
  live: "live",
  settled: "settled",
} as const;

type ActivityRecordKind = (typeof ACTIVITY_RECORD_KIND)[keyof typeof ACTIVITY_RECORD_KIND];

interface ActivityDetails {
  kind?: unknown;
  label?: unknown;
  context?: unknown;
  outcome?: unknown;
  error?: unknown;
  startedAt?: unknown;
  total?: unknown;
  runId?: unknown;
}

interface ParsedActivityDetails {
  kind: ActivityRecordKind;
  label: string;
  context: string;
  outcome: string;
  error: boolean;
  startedAt: number;
  total: number;
  runId: string;
}

interface ActivityStatusPaint {
  label: () => string;
  context: () => string;
  outcome: () => string;
  live: () => boolean;
  error: () => boolean;
  visible?: () => boolean;
  fadeKey: string;
}

function activityDetailsOf(message: unknown): ParsedActivityDetails | undefined {
  try {
    const details = ((message as { details?: unknown })?.details ?? {}) as ActivityDetails;
    if (typeof details.label !== "string" || !details.label) return undefined;
    return {
      kind: details.kind === ACTIVITY_RECORD_KIND.settled ? ACTIVITY_RECORD_KIND.settled : ACTIVITY_RECORD_KIND.live,
      label: details.label,
      context: typeof details.context === "string" ? details.context : "",
      outcome: typeof details.outcome === "string" ? details.outcome : "",
      error: details.error === true,
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

function paintActivityStatus(theme: unknown, status: ActivityStatusPaint): Container {
  const c = new Container();
  c.addChild({
    render: (width: number): readonly string[] => {
      const live = status.live();
      const error = status.error();
      const outcome = status.outcome();
      if (status.visible?.() === false) return [];
      const label = status.label();
      const context = status.context();
      const body = !live && outcome ? `${label} — ${outcome}` : label;
      const lines = [
        formatRowLine(theme, width, {
          body,
          live,
          error,
          fadeKey: status.fadeKey,
        }),
      ];
      if (context) {
        lines.push(
          formatRowLine(theme, width, {
            body: context,
            indent: true,
            tree: "last",
            error,
          }),
        );
      }
      return lines;
    },
  });
  markFlush?.(c);
  return c;
}

// Activity records are live-only. Generic tools settle into grouped rows;
// dedicated/native tools and Todo own their persistent result surfaces.
// Older sessions may contain settled records from previous plugin versions;
// render them empty so transcript rebuilds follow the current one-surface rule.
function activityRenderer(message: unknown, _options: unknown, theme: unknown): Container {
  if (!runtimeIsActive()) return new Container();
  const details = activityDetailsOf(message);
  if (!details || details.kind === ACTIVITY_RECORD_KIND.settled) return new Container();
  if (!details.runId || details.runId !== activityRunId || !activityLive) return new Container();
  const runId = details.runId;
  return paintActivityStatus(theme, {
    label: () => (runId === activityRunId ? activityLabel || details.label : details.label),
    context: () => (runId === activityRunId ? activityContext || details.context : details.context),
    outcome: () => "",
    live: () => runId === activityRunId && activityLive,
    error: () => false,
    visible: () => runId === activityRunId && activityLive,
    fadeKey: `act:${runId}`,
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
  if (!runtimeIsActive()) return new Container();
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
  const runtimeOwner = acquireRuntimeOwner();
  runtimeIsActive = runtimeOwner.owns;
  enabled = true;
  let readGroupTheme: unknown;
  // Native grouped reads (ReadToolGroupComponent) bypass the wrapped-read
  // renderers; skin them at addChild time so transcript rebuilds and live
  // grouping repaint through formatRowLine. Before any pi.on registration:
  // a rebuild can add the group before session_start fires.
  const disposeReadGroupSkin = installReadGroupSkin(Container, {
    enabled: () => runtimeOwner.owns() && enabled && wrapTool("read"),
    theme: () => readGroupTheme,
    active: runtimeOwner.owns,
  });
  const disposeAssistantCommentarySkin = installAssistantCommentarySkin(Container, {
    enabled: () => runtimeOwner.owns() && enabled,
    active: runtimeOwner.owns,
  });
  // Host warning/error panes (todo reminder, TTSR, showWarning/showError,
  // pinned ErrorBanner) -> one ⚠/✗ line. Pump slot is filled after
  // ensureSpinTimer exists; addChild-time skinning kicks it so fade/breathe
  // run even when no tool is live.
  let kickAlertPump = (): void => {};
  const disposeNativeToolCardSkin = installNativeToolCardSkin(Container, {
    enabled: () => runtimeOwner.owns() && nativeToolCardSkinActive(),
    theme: () => readGroupTheme,
    pump: () => kickAlertPump(),
    parentLabel: (toolCallId, fingerprint, result) => parentLabelForToolCall(toolCallId, fingerprint, result),
    active: runtimeOwner.owns,
  });
  const disposeWarningSkin = installWarningSkin(Container, {
    enabled: () => runtimeOwner.owns() && enabled && getPluginConfig().todoReminderOneLine !== false,
    theme: () => readGroupTheme,
    pump: () => kickAlertPump(),
    active: runtimeOwner.owns,
  });
  const disposeTodoChrome = installTodoChrome(Container, {
    hideHud: () => runtimeOwner.owns() && enabled && getPluginConfig().todoHud === false,
    hideCard: () => runtimeOwner.owns() && enabled && todosWidgetOn,
    skinCard: () => runtimeOwner.owns() && enabled,
    active: runtimeOwner.owns,
    paintCard: (width, expanded) => {
      const state = peekTodoState();
      if (!state || state.items.length === 0) return [];
      return renderTodoHeader(readGroupTheme, width, state, !expanded, todoAnim());
    },
    onHud: () => syncTodoHeaderFromSession(),
    onTodoDetails: (details) => {
      if (!todoSessionVisible) return;
      const next = parseTodoPhases(details);
      if (next) applyTodoState(next);
    },
  });
  let loaded = false;
  let spinTimer: unknown = undefined;
  let spinUi: unknown;
  let spinCtx: unknown;
  const PUMP_WIDGET_KEY = "minimal-pump";
  function grabTui(ctx: unknown): void {
    bindThoughtUi(ctx);
    bindTodosUi(ctx);
    bindTodoSource(ctx);
    const ui = todosUi ?? thoughtUi;
    if (!ui || typeof ui.setWidget !== "function") return;
    try {
      ui.setWidget(PUMP_WIDGET_KEY, (tui: unknown, theme: unknown) => {
        if (theme !== undefined) readGroupTheme = theme;
        if (typeof tui === "object" && tui !== null && "requestRender" in tui) spinUi = tui;
        const c = new Container();
        c.addChild({ render: (): readonly string[] => [] });
        return c;
      });
      ui.setWidget(PUMP_WIDGET_KEY, undefined);
    } catch {
      // Capture is best-effort; pump no-ops without TUI.
    }
  }

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
    if (!runtimeOwner.owns() || !enabled || activityApiDead) return;
    try {
      pi.sendMessage(
        { customType: "minimal-activity", content: "", display: true, details },
        { triggerTurn: false, deliverAs: "aside" },
      );
    } catch {
      activityApiDead = true;
    }
  };
  const resetActivityPresentation = (): void => {
    activityLiveSent = false;
    activityContext = "";
    activitySettledSent = false;
  };

  const maybeSendSettledActivity = (force = false): void => {
    if (
      !activityLiveSent ||
      activitySettledSent ||
      activityRunId === null ||
      (activityLive && !force) ||
      liveRuns.size > 0
    )
      return;
    activitySettledSent = true;
    markSettling(`act:${activityRunId}`);
  };

  const clearActivityRun = (): void => {
    spinStartedAt = 0;
    activityStartedAt = 0;
    activityLabel = "";
    activityLabelSource = ACTIVITY_LABEL_SOURCE.generated;
    activityLive = false;
    activityRunId = null;
    activityLeadFp = "";
    resetActivityPresentation();
  };
  const applyIntent = (text: string, startedAt: number, source: ActivityLabelSource): void => {
    if (!text) return;
    const sourceRank = ACTIVITY_LABEL_RANK[source];
    const currentRank = ACTIVITY_LABEL_RANK[activityLabelSource];
    if (activitySettledSent) {
      activityRunId = null;
      activityLabel = "";
      activityLabelSource = ACTIVITY_LABEL_SOURCE.generated;
      resetActivityPresentation();
    }
    if (activityRunId !== null && activityLive) {
      if (sourceRank < currentRank) return;
      activityLabel = text;
      activityLabelSource = source;
      return;
    }
    if (activityRunId !== null && text === activityLabel) {
      activityLive = true;
      if (sourceRank > currentRank) activityLabelSource = source;
      return;
    }
    // Several grouped tools share one status parent. While any child is
    // live, refresh the parent only from an equal or stronger source.
    if (activityRunId !== null && liveRuns.size > 0) {
      if (sourceRank < currentRank) return;
      activityLabel = text;
      activityLabelSource = source;
      activityLive = true;
      return;
    }
    if (activityRunId !== null && activityLabel) {
      maybeSendSettledActivity(true);
      activityRunId = null;
      resetActivityPresentation();
    }
    activityLabel = text;
    activityLabelSource = source;
    activityRunId = `${activityProcessTag}-${activityRunSeq++}`;
    activityStartedAt = startedAt;
    textFades.set(`act:${activityRunId}`, Date.now());
    activityLive = true;
  };
  // Row animation pump. Core only ticks spinner frames for its own
  // renderers, so custom rows animate themselves: one managed 120ms timer
  // advances the shared frame, repaints, and mirrors the latest label to
  // the working line. Row components read the frame at render time, so
  // every repaint cycles them without re-invoking renderers.
  function ensureSpinTimer(ctx: unknown): void {
    if (!runtimeOwner.owns()) return;
    spinCtx = ctx;
    bindThoughtUi(ctx);
    if (typeof ctx === "object" && ctx !== null && "ui" in ctx) {
      const ui = ctx.ui;
      if (typeof ui === "object" && ui !== null && "requestRender" in ui) {
        spinUi = ui;
      }
    }
    if (spinTimer !== undefined) return;
    const tick = (): void => {
      if (!runtimeOwner.owns()) {
        clearSpinTimer(ctx);
        return;
      }
      advanceSpinFrame();
      maybeReloadConfig();
      if (alertSkinActive()) invalidateLiveAlerts();
      const pump = spinUi;
      if (typeof pump === "object" && pump !== null && "requestRender" in pump) {
        const paint = pump.requestRender;
        if (typeof paint === "function") {
          try {
            (paint as () => void)();
          } catch {
            // Repaint is best-effort; next tick retries.
          }
        }
      }
      if (spinCtx !== undefined) stopSpinTimerIfIdle(spinCtx);
    };
    const timers = pulseTimers(ctx);
    try {
      if (timers) {
        spinTimer = timers.setInterval(tick, 120);
        return;
      }
      spinTimer = setInterval(tick, 120);
    } catch {
      spinTimer = undefined;
    }
  }
  kickAlertPump = () => {
    if (spinCtx !== undefined) ensureSpinTimer(spinCtx);
  };
  kickTodoPump = () => {
    if (spinCtx !== undefined && todoNeedsPump(todoHeaderState, todoCompletingAt, agentRunning))
      ensureSpinTimer(spinCtx);
  };
  // Best-effort repaint for hosts where the 120ms pump never starts (no
  // managed timers on ctx): without this, a pending card painted before the
  // label lands stays headerless until the settle repaint. Core coalesces
  // frames, so one extra request per tool start is cheap.
  function requestRepaint(): void {
    if (!runtimeOwner.owns()) return;
    try {
      const pump = spinUi;
      if (typeof pump === "object" && pump !== null && "requestRender" in pump) {
        const paint = pump.requestRender;
        if (typeof paint === "function") (paint as () => void)();
      }
    } catch {
      // Repaint is best-effort.
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
    // One-liners bash/read/grep/glob/write plus dedicated edit, eval, and
    // web-search cards. Execution delegates untouched native tool; only
    // transcript presentation changes.
    if (!isWrappedTool(name) || !wrapTool(name)) return;
    const src = typeof source === "object" && source !== null ? (source as Record<string, unknown>) : {};
    // NEVER register lossy stub: without native parameters shadowed schema hides
    // fields from the model (write lost `content`, grep lost `path`). Skip
    // instead — native rendering is safe degradation.
    if (src["parameters"] == null) return;
    const definition = WRAPPED_TOOL_REGISTRY[name];
    // getAllTools() does not expose native approval functions. Forward only
    // exact static fallbacks recorded in the registry; dynamic-policy tools
    // remain conservative at the extension default and cannot safely be added
    // merely by extending this registry.
    const approval = "approval" in definition ? definition.approval : undefined;
    const renderer = CARD_RENDERERS[name];
    const description = typeof src["description"] === "string" ? src["description"] : name;
    const parameters = src["parameters"];
    try {
      pi.registerTool({
        name,
        description,
        parameters: parameters as never,
        ...(approval !== undefined ? { approval: approval as never } : {}),
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
          const fingerprint = toolFingerprint(name, args);
          if (renderer)
            return renderer.renderCall(theme, args, options, fingerprint, () => parentLabelForCard(fingerprint));
          return renderToolVisual(theme, fingerprint, {
            body: toolActionLabel(name, args),
            live: cardIsPartial(options),
            error: false,
          });
        },
        renderResult(result, options, theme, args) {
          const fingerprint = toolFingerprint(name, args);
          if (renderer)
            return renderer.renderResult(theme, args, result, options, fingerprint, () =>
              parentLabelForCard(fingerprint, result),
            );
          return renderToolVisual(
            theme,
            fingerprint,
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
      wrapApplied.add(name);
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
  function clearSpinTimer(ctx: unknown = spinCtx): void {
    const timer = spinTimer;
    if (timer === undefined) return;
    try {
      pulseTimers(ctx)?.clearTimer(timer);
    } catch {
      // Managed clear is best-effort.
    }
    try {
      clearInterval(timer as ReturnType<typeof setInterval>);
    } catch {
      // Native interval fallback; ignore if this handle was managed.
    }
    spinTimer = undefined;
    const pump = spinUi;
    if (typeof pump === "object" && pump !== null && "requestRender" in pump) {
      const paint = pump.requestRender;
      if (typeof paint === "function") {
        try {
          (paint as () => void)();
        } catch {
          // Repaint is best-effort; settled rows paint on the next render.
        }
      }
    }
  }

  function stopSpinTimerIfIdle(ctx: unknown): void {
    if (
      activityLive ||
      thoughtLive ||
      liveRuns.size !== 0 ||
      nativeToolCardsNeedPump() ||
      alertSkinActive() ||
      anySettling() ||
      todoNeedsPump(todoHeaderState, todoCompletingAt, agentRunning) ||
      spinTimer === undefined
    )
      return;
    clearSpinTimer(ctx);
  }
  runtimeOwner.setCleanup(() => {
    enabled = false;
    loaded = false;
    activityApiDead = false;
    activityLive = false;
    thoughtLive = false;
    agentRunning = false;
    liveRuns.clear();
    clearActivityRun();
    thoughtText = "";
    thoughtSettledLabel = "";
    kickAlertPump = () => {};
    kickTodoPump = () => {};
    setThoughtWidget(false);
    setTodosWidget(false);
    try {
      thoughtUi?.setWidget?.(PUMP_WIDGET_KEY, undefined);
    } catch {
      // Widget cleanup is best-effort during ownership transfer.
    }
    clearSpinTimer();
    disposeTodoChrome();
    disposeWarningSkin();
    disposeNativeToolCardSkin();
    disposeAssistantCommentarySkin();
    disposeReadGroupSkin();
    spinUi = undefined;
    spinCtx = undefined;
    thoughtUi = undefined;
    todosUi = undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!runtimeOwner.owns()) return;
    resetNativeToolCardPump();
    if (loaded) return;
    loaded = true;
    resetTodoSessionState();
    reloadPluginConfig();
    try {
      lastConfigMtimes = configMtimeKey();
    } catch {
      // Missing lockfile; timer establishes the baseline.
    }
    bindThoughtUi(ctx);
    bindTodosUi(ctx);
    bindTodoSource(ctx);
    todoSessionVisible = true;
    syncTodoHeaderFromSession(ctx);
    try {
      const maybeTheme = (ctx as unknown as { ui?: { theme?: unknown } })?.ui?.theme;
      if (maybeTheme !== undefined) readGroupTheme = maybeTheme;
    } catch {
      // formatRowLine degrades to unstyled without a theme.
    }
    wrapAllTools();
    grabTui(ctx);
    ensureSpinTimer(ctx);
    try {
      if (enabled && ctx.hasUI) ctx.ui.notify("Minimal output active (grok-build style)", "info");
    } catch {
      // notify is best-effort chrome.
    }
  });
  pi.on("session_switch", async (_event, ctx) => {
    if (!runtimeOwner.owns()) return;
    agentRunning = false;
    resetTodoSessionState();
    bindTodosUi(ctx);
    bindTodoSource(ctx);
    todoSessionVisible = true;
    syncTodoHeaderFromSession(ctx);
    stopSpinTimerIfIdle(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!runtimeOwner.owns()) return;
    agentRunning = true;
    todoSessionVisible = true;
    syncTodoHeaderFromSession(ctx);
    ensureSpinTimer(ctx);
    if (todoHeaderState) refreshTodosWidget();
    reloadPluginConfig();
    try {
      lastConfigMtimes = configMtimeKey();
    } catch {
      // Missing lockfile; timer establishes the baseline.
    }
    wrapAllTools();
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!runtimeOwner.owns()) return undefined;
    try {
      if (!enabled) return undefined;
      bindTodoSource(ctx);
      const prevDetails = "details" in event ? event.details : undefined;
      // Todos cache first: runs before the collapse-eligibility guards so a
      // native todo card (no text item for textItemOf) still feeds the widget.
      if (typeof event.toolName === "string" && event.toolName.toLowerCase().includes("todo")) {
        todoSessionVisible = true;
        try {
          const next =
            parseTodoPhases("details" in event ? event.details : undefined) ??
            parseTodoResult(todoRawText(event.content));
          if (next) applyTodoState(next);
          else syncTodoHeaderFromSession(ctx);
        } catch {
          // Stale cache stays; the collapse path below is unaffected.
        }
      }
      const resultFp = eventFingerprint(event);
      const frozen = frozenGroupKeys(event.toolName);
      const withFrozen = (details: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
        if (Object.keys(frozen).length === 0) return details;
        return { ...(details ?? {}), ...frozen };
      };
      const lead =
        resultFp === activityLeadFp && activityLabel
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
    if (!runtimeOwner.owns()) return;
    if (!enabled) return;
    const startedAt = Date.now();
    const fp = eventFingerprint(event);
    const toolName =
      typeof (event as { toolName?: unknown }).toolName === "string"
        ? (event as { toolName: string }).toolName
        : "tool";
    const args = (event as { input?: unknown; args?: unknown }).input ?? (event as { args?: unknown }).args;
    const eventIntent = intentFromEvent(event);
    const intent = eventIntent ?? (activityLabel || summarizeEvent(event));
    const source = eventIntent
      ? ACTIVITY_LABEL_SOURCE.tool
      : activityRunId !== null
        ? activityLabelSource
        : ACTIVITY_LABEL_SOURCE.generated;
    applyIntent(intent, startedAt, source);
    liveRuns.set(event.toolCallId, {
      label: activityLabel || intent,
      startedAt,
      fp,
    });
    if (liveRuns.size === 1) {
      spinStartedAt = startedAt;
      activityLeadFp = fp;
    }
    tryWrapTool(toolName);
    const groupedStatus = toolUsesGroupedStatus(toolName);
    if (groupedStatus) {
      upsertGroupRow(fp, {
        body: toolActionLabel(toolName, args),
        live: true,
        error: false,
        right: "",
        startedAt,
      });
    } else if (!toolOwnsParentCard(toolName) && !activityLiveSent && activityRunId !== null) {
      activityContext = "";
      activityLiveSent = true;
      sendActivityRecord({
        kind: ACTIVITY_RECORD_KIND.live,
        label: activityLabel,
        context: activityContext,
        startedAt: activityStartedAt,
        runId: activityRunId,
      });
    }
    ensureSpinTimer(ctx);
    setThoughtWidget(false);
    requestRepaint();
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!runtimeOwner.owns()) return;
    if (!enabled) return;
    if (typeof event.toolName === "string" && event.toolName.toLowerCase().includes("todo")) {
      syncTodoHeaderFromSession(ctx);
    }
    const ended = liveRuns.get(event.toolCallId);
    liveRuns.delete(event.toolCallId);
    if (ended) markSettling(ended.fp);
    if (liveRuns.size === 0) {
      activityLive = false;
      spinStartedAt = 0;
      if (activityRunId !== null) markSettling(`act:${activityRunId}`);
      maybeSendSettledActivity();
    } else {
      let earliest = Number.POSITIVE_INFINITY;
      for (const value of liveRuns.values()) earliest = Math.min(earliest, value.startedAt);
      spinStartedAt = earliest;
    }
  });

  pi.on("message_update", async (event, ctx) => {
    if (!runtimeOwner.owns()) return;
    if (!enabled) return;
    bindThoughtUi(ctx);
    const prevRun = activityRunId;
    const prevLabel = activityLabel;
    const streamType = (event.assistantMessageEvent as { type?: unknown })?.type;
    const commentary =
      streamType === "toolcall_start" || streamType === "toolcall_end"
        ? commentaryStatusFromMessage(event.message)
        : undefined;
    const toolIntent = intentFromAssistantMessage(event.message);
    const next = commentary ?? toolIntent;
    if (next) {
      applyIntent(next, Date.now(), commentary ? ACTIVITY_LABEL_SOURCE.commentary : ACTIVITY_LABEL_SOURCE.tool);
      ensureSpinTimer(ctx);
    }
    const thinking = extractThinking(event.message);
    if (thinking.text) thoughtText = thinking.text;
    if (thinking.live) {
      thoughtLive = true;
      if (!activityRunId) {
        applyIntent("Working", Date.now(), ACTIVITY_LABEL_SOURCE.generated);
      }
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
    if (!runtimeOwner.owns()) return;
    liveRuns.clear();
    agentRunning = false;
    activityLive = false;
    maybeSendSettledActivity(true);
    clearActivityRun();
    resetThought();
    refreshTodosWidget();
    stopSpinTimerIfIdle(ctx);
    setWorking(ctx, undefined);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!runtimeOwner.owns()) return;
    liveRuns.clear();
    agentRunning = false;
    activityLive = false;
    maybeSendSettledActivity(true);
    clearActivityRun();
    resetThought();
    refreshTodosWidget();
    stopSpinTimerIfIdle(ctx);
    setWorking(ctx, undefined);
    syncTodoHeaderFromSession(ctx);
  });

  pi.registerCommand("minimal-on", {
    description: "Enable grok-build-style minimal output",
    handler: async (_args, ctx) => {
      if (!runtimeOwner.owns()) return;
      enabled = true;
      clearActivityRun();
      installTodosWidget();
      ctx.ui.notify("Minimal output enabled", "info");
    },
  });

  pi.registerCommand("minimal-off", {
    description: "Disable grok-build-style minimal output",
    handler: async (_args, ctx) => {
      if (!runtimeOwner.owns()) return;
      liveRuns.clear();
      agentRunning = false;
      activityLive = false;
      maybeSendSettledActivity(true);
      enabled = false;
      resetNativeToolCardPump();
      clearActivityRun();
      setTodosWidget(false);
      resetThought();
      stopSpinTimerIfIdle(ctx);
      setWorking(ctx, undefined);
      ctx.ui.notify("Minimal output disabled", "warning");
    },
  });

  pi.on("session_shutdown", async () => {
    if (!runtimeOwner.owns()) return;
    runtimeOwner.release();
  });
  pi.registerCommand("todos-show", {
    description: "Show the current session todo card",
    handler: async (_args, ctx) => {
      if (!runtimeOwner.owns()) return;
      todoSessionVisible = true;
      syncTodoHeaderFromSession(ctx);
      installTodosWidget();
      const hasTodos = !!todoHeaderState && todoHeaderState.items.length > 0;
      ctx.ui.notify(
        todosWidgetOn ? "Todos shown" : hasTodos ? "Todos header is disabled" : "No todos in this session",
        "info",
      );
    },
  });

  pi.registerCommand("todos", {
    description: "Toggle todos widget expand/collapse",
    handler: async (_args, ctx) => {
      if (!runtimeOwner.owns()) return;
      todosCollapsed = !todosCollapsed;
      refreshTodosWidget();
      ctx.ui.notify(todosCollapsed ? "Todos collapsed" : "Todos expanded", "info");
    },
  });

  pi.registerShortcut("ctrl+alt+t", {
    description: "Toggle todos widget expand/collapse",
    handler: async () => {
      if (!runtimeOwner.owns()) return;
      todosCollapsed = !todosCollapsed;
      refreshTodosWidget();
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
      if (!runtimeOwner.owns()) return;
      const cfg = getPluginConfig();
      const native: string[] = [];
      if (cfg.nativeBash) native.push("bash");
      if (cfg.nativeRead) native.push("read");
      if (cfg.nativeGrep) native.push("grep");
      if (cfg.nativeGlob) native.push("glob");
      if (cfg.nativeWrite) native.push("write");
      if (cfg.nativeEdit) native.push("edit");
      if (cfg.nativeEval) native.push("eval");
      if (cfg.nativeWebSearch) native.push("web_search");
      if (cfg.nativeTask) native.push("task");
      if (cfg.nativeHub) native.push("hub");
      ctx.ui.notify(
        `Minimal output: ${enabled ? "on" : "off"} (collapsed rows, shimmer disabled) opacity=${cfg.opacity} indicator=${cfg.indicator} anim=${cfg.indicatorAnimation ? "on" : "off"} native=[${native.join(",")}] searchMax=${cfg.webSearchMaxResults} taskMax=${cfg.taskMaxAgents} hubMax=${cfg.hubMaxItems} tabs=${cfg.editShowTabs ? "on" : "off"} spaces=${cfg.editShowSpaces ? "on" : "off"} reminder=${cfg.todoReminderOneLine !== false ? "on" : "off"}`,
        "info",
      );
    },
  });
}

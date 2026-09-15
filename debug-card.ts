// Display-only projection of native debugger state. DAP sessions and mutations remain owned by Oh My Pi.
import { Container } from "@oh-my-pi/pi-tui";
import {
  cardDetailLine,
  cardHeaderLine,
  cardLifecycle,
  cardTitleLine,
  compactCardText,
  conciseErrorText,
  resultDetails,
  stashedOrResultText,
} from "./card-primitives.ts";
import { getPluginConfig } from "./config.ts";
import { markFlush } from "./loaders.ts";

export const DEBUG_ACTION = {
  attach: "attach",
  continue: "continue",
  customRequest: "custom_request",
  dataBreakpointInfo: "data_breakpoint_info",
  disassemble: "disassemble",
  evaluate: "evaluate",
  launch: "launch",
  loadedSources: "loaded_sources",
  modules: "modules",
  output: "output",
  pause: "pause",
  readMemory: "read_memory",
  removeBreakpoint: "remove_breakpoint",
  removeDataBreakpoint: "remove_data_breakpoint",
  removeInstructionBreakpoint: "remove_instruction_breakpoint",
  scopes: "scopes",
  sessions: "sessions",
  setBreakpoint: "set_breakpoint",
  setDataBreakpoint: "set_data_breakpoint",
  setInstructionBreakpoint: "set_instruction_breakpoint",
  stackTrace: "stack_trace",
  stepIn: "step_in",
  stepOut: "step_out",
  stepOver: "step_over",
  terminate: "terminate",
  threads: "threads",
  variables: "variables",
  writeMemory: "write_memory",
} as const;

export type DebugAction = (typeof DEBUG_ACTION)[keyof typeof DEBUG_ACTION];

interface DebugCardData {
  action: DebugAction;
  target: string;
  rows: readonly string[];
  itemCount: number;
  failure: boolean;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function fieldText(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
  max: number,
): string {
  if (!record) return "";
  for (const key of keys) {
    const text = compactCardText(record[key], max);
    if (text) return text;
  }
  return "";
}

export function isDebugAction(value: unknown): value is DebugAction {
  return typeof value === "string" && Object.values(DEBUG_ACTION).includes(value as DebugAction);
}

/** Strict selector for the native Debug component skin. */
export function isDebugCardData(args: unknown, result?: unknown): boolean {
  const fields = recordOf(args);
  if (isDebugAction(fields?.["action"])) return true;
  return isDebugAction(resultDetails(result)?.["action"]);
}

function baseName(path: string): string {
  const parts = path.replace(/\\/gu, "/").split("/");
  return parts.at(-1) ?? path;
}

function targetOf(fields: Record<string, unknown> | undefined): string {
  const file = fieldText(fields, ["file"], 160);
  const line = fieldText(fields, ["line"], 12);
  if (file) return `${baseName(file)}${line ? `:${line}` : ""}`;
  const program = fieldText(fields, ["program"], 160);
  if (program) return baseName(program);
  const pid = fieldText(fields, ["pid"], 24);
  if (pid) return `pid ${pid}`;
  return fieldText(
    fields,
    ["function", "expression", "name", "memory_reference", "instruction_reference", "command"],
    80,
  );
}

function resultRows(result: unknown): string[] {
  const rows: string[] = [];
  for (const rawLine of stashedOrResultText(result).split("\n")) {
    const line = compactCardText(rawLine, 700);
    if (!line || /^```/u.test(line) || /^◆\s+Debug\b/iu.test(line)) continue;
    rows.push(line);
  }
  return rows;
}

function structuredCount(details: Record<string, unknown> | undefined): number {
  if (!details) return 0;
  for (const key of [
    "threads",
    "frames",
    "variables",
    "breakpoints",
    "sessions",
    "modules",
    "sources",
    "items",
    "results",
  ] as const) {
    const value = details[key];
    if (Array.isArray(value)) return value.length;
  }
  return 0;
}

function debugFailure(result: unknown): boolean {
  if (compactCardText(resultDetails(result)?.["error"], 200)) return true;
  const text = stashedOrResultText(result);
  if (/\bno debug sessions\b/iu.test(text)) return false;
  return /(?:no active debug session|(?:^|\n)\s*(?:error|failed)\b|not supported|breakpoint not found)/iu.test(text);
}

function debugData(args: unknown, result: unknown): DebugCardData | undefined {
  if (!isDebugCardData(args, result)) return undefined;
  const fields = recordOf(args);
  const details = resultDetails(result);
  const action = isDebugAction(fields?.["action"])
    ? fields["action"]
    : isDebugAction(details?.["action"])
      ? details["action"]
      : undefined;
  if (!action) return undefined;
  const rows = resultRows(result);
  return {
    action,
    target: targetOf(fields),
    rows,
    itemCount: structuredCount(details) || rows.length,
    failure: debugFailure(result),
  };
}

function summaryOf(data: DebugCardData): string {
  if (data.failure) return "failed";
  if (data.action === DEBUG_ACTION.sessions && data.rows.some((row) => /no debug sessions/iu.test(row))) {
    return "0 sessions";
  }
  switch (data.action) {
    case DEBUG_ACTION.attach:
      return "attached";
    case DEBUG_ACTION.continue:
      return "continued";
    case DEBUG_ACTION.launch:
      return "launched";
    case DEBUG_ACTION.pause:
      return "paused";
    case DEBUG_ACTION.removeBreakpoint:
    case DEBUG_ACTION.removeDataBreakpoint:
    case DEBUG_ACTION.removeInstructionBreakpoint:
      return "breakpoint removed";
    case DEBUG_ACTION.setBreakpoint:
    case DEBUG_ACTION.setDataBreakpoint:
    case DEBUG_ACTION.setInstructionBreakpoint:
      return "breakpoint set";
    case DEBUG_ACTION.stepIn:
    case DEBUG_ACTION.stepOut:
    case DEBUG_ACTION.stepOver:
      return "stepped";
    case DEBUG_ACTION.terminate:
      return "terminated";
    case DEBUG_ACTION.threads:
      return `${data.itemCount} ${data.itemCount === 1 ? "thread" : "threads"}`;
    case DEBUG_ACTION.stackTrace:
      return `${data.itemCount} ${data.itemCount === 1 ? "frame" : "frames"}`;
    case DEBUG_ACTION.variables:
      return `${data.itemCount} ${data.itemCount === 1 ? "variable" : "variables"}`;
    case DEBUG_ACTION.sessions:
      return `${data.itemCount} ${data.itemCount === 1 ? "session" : "sessions"}`;
    default:
      return "completed";
  }
}

export function renderDebugCardLines(
  theme: unknown,
  width: number,
  args: unknown,
  result: unknown,
  options: unknown,
  fingerprint?: string,
): readonly string[] | undefined {
  const data = debugData(args, result);
  if (!data) return undefined;
  const lifecycle = cardLifecycle(result, options, { error: data.failure });
  const base = `Debug ${data.action}${data.target ? ` ${data.target}` : ""}`;
  const lines = [
    cardHeaderLine(theme, width, {
      body: `${base} — ${lifecycle.running ? "running" : summaryOf(data)}`,
      lifecycle,
      fingerprint,
      settledMark: "●",
    }),
  ];
  if (!lifecycle.expanded || lifecycle.running) return lines;
  if (lifecycle.error) {
    lines.push(
      cardTitleLine(
        theme,
        width,
        conciseErrorText(result, {
          fallback: `Debug ${data.action} failed`,
          skipPattern: /^●?\s*Debug\b/iu,
        }),
        true,
      ),
    );
    return lines;
  }
  const visible = data.rows.slice(0, getPluginConfig().debugMaxItems);
  for (const row of visible) lines.push(cardDetailLine(theme, width, row));
  const hidden = data.rows.length - visible.length;
  if (hidden > 0) {
    lines.push(cardDetailLine(theme, width, `… ${hidden} more ${hidden === 1 ? "item" : "items"}`));
  }
  return lines;
}

export function renderDebugCard(
  theme: unknown,
  args: unknown,
  result: unknown,
  options: unknown,
  fingerprint?: string,
): Container {
  const card = new Container();
  card.addChild({
    render: (width: number): readonly string[] =>
      renderDebugCardLines(theme, width, args, result, options, fingerprint) ?? [],
  });
  markFlush?.(card);
  return card;
}

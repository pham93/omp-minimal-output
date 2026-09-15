// Display-only projection of native Hub tool state. Execution and approval stay in Oh My Pi.
import { Container } from "@oh-my-pi/pi-tui";
import {
  cardDetailLine,
  parentCardHeaderLines,
  cardLifecycle,
  cardTitleLine,
  compactCardText,
  conciseErrorText,
  resultDetails,
} from "./card-primitives.ts";
import type { ParentCardLabel } from "./card-primitives.ts";
import { getPluginConfig } from "./config.ts";
import { markFlush } from "./loaders.ts";

export const HUB_OPERATION = {
  cancel: "cancel",
  describe: "describe",
  inbox: "inbox",
  jobs: "jobs",
  list: "list",
  logs: "logs",
  ps: "ps",
  restart: "restart",
  send: "send",
  start: "start",
  stop: "stop",
  wait: "wait",
} as const;

export type HubOperation = (typeof HUB_OPERATION)[keyof typeof HUB_OPERATION];

const HUB_DETAIL_DISCRIMINATOR = {
  agents: true,
  cancelled: true,
  cursor: true,
  daemon: true,
  daemons: true,
  inbox: true,
  jobs: true,
  matched: true,
  peers: true,
  receipts: true,
  spec: true,
  state: true,
  terminalRows: true,
  timedOut: true,
  waited: true,
} as const;

interface HubRow {
  title: string;
  detail: string;
  failed: boolean;
}

interface HubCardData {
  op: HubOperation;
  target: string;
  summary: string;
  rows: readonly HubRow[];
  rowCount: number;
  failure: boolean;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textOf(value: unknown, max: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return compactCardText(value, max);
}

function recordText(record: Record<string, unknown> | undefined, keys: readonly string[], max: number): string {
  if (!record) return "";
  for (const key of keys) {
    const text = textOf(record[key], max);
    if (text) return text;
  }
  return "";
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

export function isHubOperation(value: unknown): value is HubOperation {
  return typeof value === "string" && hasOwn(HUB_OPERATION, value);
}

function hubArgMatches(args: unknown): boolean {
  return isHubOperation(recordOf(args)?.["op"]);
}

function hubDetailsMatch(result: unknown): boolean {
  const details = resultDetails(result);
  if (!details || !isHubOperation(details["op"])) return false;
  return Object.keys(HUB_DETAIL_DISCRIMINATOR).some((key) => hasOwn(details, key));
}

/** Strict native Hub selector used by the display-only ToolExecutionComponent skin. */
export function isHubCardData(args: unknown, result: unknown): boolean {
  return hubArgMatches(args) || hubDetailsMatch(result);
}

function failureOf(fields: Record<string, unknown> | undefined): boolean {
  if (!fields) return false;
  if (fields["isError"] === true || fields["success"] === false || fields["ok"] === false) return true;
  if (textOf(fields["error"], 1) !== "") return true;
  for (const key of ["status", "state", "outcome"] as const) {
    if (/(?:fail|error|abort)/.test(textOf(fields[key], 64).toLowerCase())) return true;
  }
  return false;
}

function stateOf(fields: Record<string, unknown>, fallback: string): string {
  const status = recordText(fields, ["status", "state", "outcome"], 48);
  if (status) return status;
  if (typeof fields["live"] === "boolean") return fields["live"] ? "running" : "idle";
  return fallback;
}

function subjectOf(fields: Record<string, unknown>, fallback: string): string {
  return recordText(fields, ["displayName", "name", "id", "jobId", "agent", "to", "from"], 96) || fallback;
}

function projectedRow(kind: string, fields: Record<string, unknown>, fallback: string, detail: string): HubRow {
  const failed = failureOf(fields);
  const status = stateOf(fields, failed ? "failed" : "completed");
  return {
    title: `${kind} ${subjectOf(fields, fallback)} — ${status}`,
    detail,
    failed,
  };
}

function pushRecordRows(
  rows: HubRow[],
  values: unknown,
  kind: string,
  max: number,
  detailOf: (fields: Record<string, unknown>) => string,
): void {
  const candidates = Array.isArray(values) ? values : [values];
  const inspectLimit = Math.max(0, max - rows.length);
  for (let index = 0; index < candidates.length && index < inspectLimit; index += 1) {
    const fields = recordOf(candidates[index]);
    if (!fields) continue;
    rows.push(projectedRow(kind, fields, String(index + 1), detailOf(fields)));
  }
}

function pushTerminalRows(rows: HubRow[], value: unknown, max: number): void {
  if (!Array.isArray(value)) return;
  const inspectLimit = Math.max(0, max - rows.length);
  for (let index = 0; index < value.length && index < inspectLimit; index += 1) {
    const raw = value[index];
    const text = textOf(raw, 240) || recordText(recordOf(raw), ["text", "line", "message"], 240);
    if (!text) continue;
    rows.push({ title: `terminal ${index + 1}`, detail: text, failed: false });
  }
}

function pushCancelledRows(rows: HubRow[], value: unknown, max: number): void {
  if (!Array.isArray(value)) return;
  const inspectLimit = Math.max(0, max - rows.length);
  for (let index = 0; index < value.length && index < inspectLimit; index += 1) {
    const raw = value[index];
    const fields = recordOf(raw);
    if (fields) {
      rows.push(projectedRow("cancelled", fields, String(index + 1), "cancelled"));
      continue;
    }
    const id = textOf(raw, 96);
    if (id)
      rows.push({
        title: `cancelled ${id} — cancelled`,
        detail: "cancelled",
        failed: false,
      });
  }
}

function hubRows(details: Record<string, unknown> | undefined, max: number): readonly HubRow[] {
  if (!details || max <= 0) return [];
  const rows: HubRow[] = [];
  pushRecordRows(rows, details["peers"], "peer", max, (fields) => recordText(fields, ["role", "status"], 160));
  pushRecordRows(rows, details["jobs"], "job", max, (fields) =>
    recordText(fields, ["label", "task", "resultText", "errorText", "message"], 180),
  );
  pushRecordRows(rows, details["agents"], "agent", max, (fields) =>
    recordText(fields, ["activity", "task", "summary", "message"], 180),
  );
  pushRecordRows(rows, details["receipts"], "receipt", max, (fields) =>
    recordText(fields, ["messageId", "id", "error"], 120),
  );
  pushRecordRows(rows, details["inbox"], "message", max, (fields) =>
    recordText(fields, ["text", "message", "content", "summary"], 200),
  );
  pushRecordRows(rows, details["waited"], "waited", max, (fields) =>
    recordText(fields, ["text", "message", "content", "reason"], 160),
  );
  pushRecordRows(rows, details["daemons"], "daemon", max, (fields) =>
    recordText(fields, ["state", "pid", "exitReason"], 120),
  );
  pushRecordRows(rows, details["daemon"], "daemon", max, (fields) => recordText(fields, ["state", "pid"], 120));
  pushTerminalRows(rows, details["terminalRows"], max);
  pushCancelledRows(rows, details["cancelled"], max);
  return rows;
}

function knownRowCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return recordOf(value) ? 1 : 0;
}

function hubRowCount(details: Record<string, unknown> | undefined): number {
  if (!details) return 0;
  let total = 0;
  for (const key of ["peers", "jobs", "agents", "receipts", "inbox", "waited", "daemons", "daemon"] as const) {
    total += knownRowCount(details[key]);
  }
  if (Array.isArray(details["terminalRows"])) total += details["terminalRows"].length;
  if (Array.isArray(details["cancelled"])) total += details["cancelled"].length;
  return total;
}

function hubRowsHaveFailure(details: Record<string, unknown> | undefined): boolean {
  if (!details) return false;
  for (const key of [
    "peers",
    "jobs",
    "agents",
    "receipts",
    "inbox",
    "waited",
    "daemons",
    "daemon",
    "cancelled",
  ] as const) {
    const value = details[key];
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (failureOf(recordOf(candidate))) return true;
    }
  }
  return false;
}

function targetOf(op: HubOperation, args: unknown, details: Record<string, unknown> | undefined): string {
  if ([HUB_OPERATION.list, HUB_OPERATION.inbox, HUB_OPERATION.jobs, HUB_OPERATION.ps].includes(op)) return "";
  const argFields = recordOf(args);
  const spec = recordOf(details?.["spec"]);
  const target =
    recordText(argFields, ["name", "to", "from"], 96) ||
    recordText(spec, ["name", "target"], 96) ||
    recordText(details, ["name", "to", "from"], 96);
  if (target) return target;
  const ids = argFields?.["ids"];
  if (Array.isArray(ids) && ids.length > 0) return `${ids.length} ${ids.length === 1 ? "item" : "items"}`;
  return "session";
}

function knownCount(value: unknown): number {
  return Array.isArray(value) ? value.length : value === undefined ? 0 : 1;
}

function countSummary(details: Record<string, unknown>): string {
  const counts = recordOf(details["counts"]);
  for (const [key, label] of [
    ["peers", "peers"],
    ["jobs", "jobs"],
    ["processes", "processes"],
    ["messages", "messages"],
  ] as const) {
    const value = counts?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return `${Math.floor(value)} ${label}`;
  }
  for (const [key, label] of [
    ["peers", "peers"],
    ["jobs", "jobs"],
    ["agents", "agents"],
    ["daemons", "processes"],
    ["inbox", "messages"],
  ] as const) {
    const count = knownCount(details[key]);
    if (count > 0) return `${count} ${label}`;
  }
  return "";
}

function summaryOf(details: Record<string, unknown> | undefined, failure: boolean): string {
  if (!details) return failure ? "failed" : "completed";
  if (failure) return "failed";
  const daemon = recordOf(details["daemon"]);
  const state = (textOf(details["state"], 32) || textOf(daemon?.["state"], 32)).toLowerCase();
  if (["ready", "running", "stopped", "exited"].includes(state)) return state;
  if (details["timedOut"] === true || details["waited"] === null) return "timed out";
  const receipts = knownCount(details["receipts"]);
  if (receipts > 0) return `${receipts} delivered`;
  if (hasOwn(details, "waited")) return "message received";
  const counted = countSummary(details);
  if (counted) return counted;
  if (knownCount(details["cancelled"]) > 0) return `${knownCount(details["cancelled"])} cancelled`;
  return "completed";
}

function hubData(args: unknown, result: unknown, rowBudget: number): HubCardData | undefined {
  if (!isHubCardData(args, result)) return undefined;
  const argsFields = recordOf(args);
  const details = resultDetails(result);
  const op = isHubOperation(argsFields?.["op"])
    ? argsFields["op"]
    : isHubOperation(details?.["op"])
      ? details["op"]
      : undefined;
  if (!op) return undefined;
  const rows = hubRows(details, rowBudget);
  const failure = failureOf(recordOf(result)) || failureOf(details) || hubRowsHaveFailure(details);
  return {
    op,
    target: targetOf(op, args, details),
    summary: summaryOf(details, failure),
    rows,
    rowCount: hubRowCount(details),
    failure,
  };
}

/** Shared Hub card painter used by both gallery fixtures and the native skin. */
export function renderHubCardLines(
  theme: unknown,
  width: number,
  args: unknown,
  result: unknown,
  options: unknown,
  fingerprint?: string,
  parentLabel?: ParentCardLabel,
): readonly string[] | undefined {
  const maxItems = getPluginConfig().hubMaxItems;
  const data = hubData(args, result, maxItems);
  if (!data) return undefined;
  const lifecycle = cardLifecycle(result, options, { error: data.failure });
  const lines = parentCardHeaderLines(theme, width, {
    body: `Hub ${data.op}${data.target ? ` ${data.target}` : ""} — ${lifecycle.running ? "running" : data.summary}`,
    lifecycle,
    fingerprint,
    settledMark: "●",
    parentLabel,
  });
  if (!lifecycle.expanded) return lines;
  if (data.rows.length === 0) {
    if (lifecycle.error) {
      lines.push(
        cardTitleLine(
          theme,
          width,
          conciseErrorText(result, {
            fallback: `Hub ${data.op} failed`,
            skipPattern: /^●?\s*Hub\b/i,
          }),
          true,
        ),
      );
    }
    return lines;
  }
  const visible = data.rows.slice(0, maxItems);
  for (const row of visible) {
    lines.push(cardTitleLine(theme, width, row.title, row.failed));
    if (row.detail) lines.push(cardDetailLine(theme, width, row.detail));
  }
  const hidden = Math.max(0, data.rowCount - visible.length);
  if (hidden > 0) lines.push(cardDetailLine(theme, width, `… ${hidden} more items`));
  return lines;
}

export function renderHubCard(
  theme: unknown,
  args: unknown,
  result: unknown,
  options: unknown,
  fingerprint?: string,
  parentLabel?: ParentCardLabel,
): Container {
  const card = new Container();
  card.addChild({
    render: (width: number): readonly string[] =>
      renderHubCardLines(theme, width, args, result, options, fingerprint, parentLabel) ?? [],
  });
  markFlush?.(card);
  return card;
}

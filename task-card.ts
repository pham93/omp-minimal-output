// Display-only projection of native Task tool state. Execution and native schemas stay in Oh My Pi.
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

interface TaskAgentRow {
  agent: string;
  status: string;
  task: string;
  output: string;
  error: string;
  artifact: string;
  failed: boolean;
}

interface TaskCardData {
  agents: number;
  singleAgent: string;
  completed: number;
  failed: number;
  rows: readonly TaskAgentRow[];
  rowCount: number;
  duration: string;
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

function contentText(value: unknown, max: number): string {
  const direct = textOf(value, max);
  if (direct) return direct;
  if (!Array.isArray(value)) return "";
  for (let index = 0; index < Math.min(value.length, 8); index += 1) {
    const itemRecord = recordOf(value[index]);
    const text = recordText(itemRecord, ["text"], max);
    if (text) return text;
  }
  return "";
}

function taskArgMatches(args: unknown): boolean {
  const fields = recordOf(args);
  if (!fields) return false;
  const hasTask = textOf(fields["task"], 1) !== "";
  const tasks = fields["tasks"];
  const hasTasks = Array.isArray(tasks) && tasks.length > 0;
  const hasRouting = textOf(fields["agent"], 1) !== "" || textOf(fields["context"], 1) !== "";
  return (hasTask || hasTasks) && hasRouting;
}

function taskDetailsMatch(result: unknown): boolean {
  const details = resultDetails(result);
  if (!details || !Array.isArray(details["results"])) return false;
  return (
    (typeof details["totalDurationMs"] === "number" && Number.isFinite(details["totalDurationMs"])) ||
    textOf(details["projectAgentsDir"], 1) !== "" ||
    Array.isArray(details["progress"]) ||
    recordOf(details["progress"]) !== undefined
  );
}

/** Strict native Task selector used by the display-only ToolExecutionComponent skin. */
export function isTaskCardData(args: unknown, result: unknown): boolean {
  return taskArgMatches(args) || taskDetailsMatch(result);
}

function failureOf(fields: Record<string, unknown> | undefined): boolean {
  if (!fields) return false;
  if (
    fields["isError"] === true ||
    fields["success"] === false ||
    fields["ok"] === false ||
    fields["aborted"] === true
  ) {
    return true;
  }
  const exitCode = fields["exitCode"];
  if (typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0) return true;
  if (textOf(fields["error"], 1) !== "") return true;
  for (const key of ["status", "state", "outcome"] as const) {
    const status = textOf(fields[key], 64).toLowerCase();
    if (/(?:fail|error|abort)/.test(status)) return true;
  }
  return false;
}

function statusOf(fields: Record<string, unknown>, failed: boolean): string {
  const status = recordText(fields, ["status", "state", "outcome"], 48);
  if (status) return status;
  if (fields["aborted"] === true) return "aborted";
  return failed ? "failed" : "completed";
}

function agentOf(fields: Record<string, unknown>): string {
  const direct = recordText(fields, ["agentName", "name", "id", "agent"], 80);
  if (direct) return direct;
  const agent = recordOf(fields["agent"]);
  return recordText(agent, ["name", "id", "agent"], 80) || "agent";
}

function artifactOf(fields: Record<string, unknown>, nested: Record<string, unknown> | undefined): string {
  const direct = recordText(fields, ["artifact", "artifactPath", "outputPath", "patchPath", "path"], 180);
  if (direct) return direct;
  const nestedDirect = recordText(nested, ["artifact", "artifactPath", "outputPath", "patchPath", "path"], 180);
  if (nestedDirect) return nestedDirect;
  for (const value of [fields["artifacts"], nested?.["artifacts"]]) {
    if (!Array.isArray(value)) continue;
    for (let index = 0; index < Math.min(value.length, 8); index += 1) {
      const text = textOf(value[index], 180);
      if (text) return text;
    }
  }
  return "";
}

function taskRowOf(value: unknown): TaskAgentRow | undefined {
  const fields = recordOf(value);
  if (!fields) return undefined;
  const nested = recordOf(fields["result"]);
  const failed = failureOf(fields) || failureOf(nested);
  const task =
    recordText(fields, ["task", "prompt", "description"], 180) || recordText(nested, ["task", "prompt"], 180);
  const output =
    recordText(fields, ["output", "summary", "message"], 240) ||
    contentText(fields["content"], 240) ||
    recordText(nested, ["output", "summary", "message"], 240) ||
    contentText(nested?.["content"], 240);
  const error =
    recordText(fields, ["error", "reason", "stderr", "abortReason"], 180) ||
    recordText(nested, ["error", "reason", "stderr", "abortReason"], 180);
  return {
    agent: agentOf(fields),
    status: statusOf(fields, failed),
    task,
    output,
    error,
    artifact: artifactOf(fields, nested),
    failed,
  };
}

function requestedAgents(args: unknown): number {
  const fields = recordOf(args);
  if (!fields) return 0;
  const tasks = fields["tasks"];
  if (Array.isArray(tasks) && tasks.length > 0) return tasks.length;
  return textOf(fields["task"], 1) ? 1 : 0;
}

function requestedAgentName(args: unknown): string {
  const fields = recordOf(args);
  return recordText(fields, ["name", "agent"], 80) || recordText(recordOf(fields?.["agent"]), ["name", "id"], 80);
}

function durationOf(details: Record<string, unknown> | undefined): string {
  const duration = details?.["totalDurationMs"];
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) return "";
  return `${(duration / 1000).toFixed(duration < 10_000 ? 1 : 0)}s`;
}

function taskData(args: unknown, result: unknown, rowBudget: number): TaskCardData | undefined {
  if (!isTaskCardData(args, result)) return undefined;
  const details = resultDetails(result);
  const rawResults = details && Array.isArray(details["results"]) ? details["results"] : [];
  const progress = details?.["progress"];
  const rawProgress = Array.isArray(progress) ? progress : Object.values(recordOf(progress) ?? {});
  const rawRows = rawResults.length > 0 ? rawResults : rawProgress;
  const rows: TaskAgentRow[] = [];
  let completed = 0;
  let failed = 0;
  let rowCount = 0;
  for (const value of rawRows) {
    const fields = recordOf(value);
    if (!fields) continue;
    rowCount += 1;
    const nested = recordOf(fields["result"]);
    const rowFailed = failureOf(fields) || failureOf(nested);
    const status = statusOf(fields, rowFailed);
    if (rowFailed) failed += 1;
    else if (/^(?:completed|done|success|succeeded)$/i.test(status)) completed += 1;
    if (rows.length < rowBudget) {
      const row = taskRowOf(value);
      if (row) rows.push(row);
    }
  }
  const requested = requestedAgents(args);
  return {
    agents: Math.max(1, requested, rowCount),
    singleAgent: rows[0]?.agent || requestedAgentName(args),
    completed,
    failed,
    rows,
    rowCount,
    duration: durationOf(details),
    failure: failed > 0 || failureOf(recordOf(result)) || failureOf(details),
  };
}

function taskHeader(data: TaskCardData, running: boolean): string {
  const identity = data.agents === 1 ? `agent ${data.singleAgent || "task"}` : `${data.agents} agents`;
  if (running) {
    return data.completed > 0
      ? `Task ${identity} — ${data.completed} completed · running`
      : `Task ${identity} — running`;
  }
  if (data.failure && data.failed === 0) return `Task ${identity} — failed`;
  if (data.failed > 0 && data.completed > 0) {
    return `Task ${identity} — mixed: ${data.completed} completed · ${data.failed} failed`;
  }
  if (data.failed > 0) return `Task ${identity} — failed: ${data.failed}`;
  return `Task ${identity} — completed${data.completed > 1 ? `: ${data.completed}` : ""}`;
}

/** Shared Task card painter used by both gallery fixtures and the native skin. */
export function renderTaskCardLines(
  theme: unknown,
  width: number,
  args: unknown,
  result: unknown,
  options: unknown,
  fingerprint?: string,
  parentLabel?: ParentCardLabel,
): readonly string[] | undefined {
  const maxAgents = getPluginConfig().taskMaxAgents;
  const data = taskData(args, result, maxAgents);
  if (!data) return undefined;
  const lifecycle = cardLifecycle(result, options, { error: data.failure });
  const lines = parentCardHeaderLines(theme, width, {
    body: taskHeader(data, lifecycle.running),
    lifecycle,
    right: data.duration,
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
            fallback: "Task failed",
            skipPattern: /^●?\s*Task\b/i,
          }),
          true,
        ),
      );
    }
    return lines;
  }
  const visible = data.rows.slice(0, maxAgents);
  for (const row of visible) {
    lines.push(cardTitleLine(theme, width, `${row.agent} — ${row.status}`, row.failed));
    if (row.task) lines.push(cardDetailLine(theme, width, `task: ${row.task}`));
    if (row.output) lines.push(cardDetailLine(theme, width, `output: ${row.output}`));
    if (row.error) lines.push(cardDetailLine(theme, width, `error: ${row.error}`));
    if (row.artifact) lines.push(cardDetailLine(theme, width, `artifact: ${row.artifact}`));
  }
  const hidden = Math.max(0, data.rowCount - visible.length);
  if (hidden > 0) {
    lines.push(cardDetailLine(theme, width, `… ${hidden} more ${hidden === 1 ? "agent" : "agents"}`));
  }
  return lines;
}

export function renderTaskCard(
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
      renderTaskCardLines(theme, width, args, result, options, fingerprint, parentLabel) ?? [],
  });
  markFlush?.(card);
  return card;
}

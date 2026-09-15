// Display-only projection of native LSP tool state. Schema, edits, and language-server execution stay native.
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

export const LSP_ACTION = {
  capabilities: "capabilities",
  codeActions: "code_actions",
  definition: "definition",
  diagnostics: "diagnostics",
  hover: "hover",
  implementation: "implementation",
  references: "references",
  reload: "reload",
  rename: "rename",
  renameFile: "rename_file",
  request: "request",
  status: "status",
  symbols: "symbols",
  typeDefinition: "type_definition",
} as const;

export type LspAction = (typeof LSP_ACTION)[keyof typeof LSP_ACTION];

interface LspCardData {
  action: LspAction;
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

export function isLspAction(value: unknown): value is LspAction {
  return typeof value === "string" && Object.values(LSP_ACTION).includes(value as LspAction);
}

/** Strict selector for the native LSP component skin. */
export function isLspCardData(args: unknown, result?: unknown): boolean {
  const argsFields = recordOf(args);
  if (isLspAction(argsFields?.["action"])) return true;
  return isLspAction(resultDetails(result)?.["action"]);
}

function baseName(path: string): string {
  const parts = path.replace(/\\/gu, "/").split("/");
  return parts.at(-1) ?? path;
}

function targetOf(fields: Record<string, unknown> | undefined): string {
  const symbol = fieldText(fields, ["symbol", "new_name"], 80);
  if (symbol) return symbol;
  const file = fieldText(fields, ["file"], 160);
  if (file) return baseName(file);
  return fieldText(fields, ["query"], 80);
}

function resultRows(result: unknown): string[] {
  const rows: string[] = [];
  for (const rawLine of stashedOrResultText(result).split("\n")) {
    const line = compactCardText(rawLine, 700);
    if (!line || /^```/u.test(line) || /^◆\s+Lsp\b/iu.test(line)) continue;
    rows.push(line);
  }
  return rows;
}

function structuredCount(details: Record<string, unknown> | undefined): number {
  if (!details) return 0;
  for (const key of [
    "diagnostics",
    "references",
    "definitions",
    "implementations",
    "symbols",
    "actions",
    "locations",
    "items",
    "results",
  ] as const) {
    const value = details[key];
    if (Array.isArray(value)) return value.length;
  }
  return 0;
}

function visibleItemCount(rows: readonly string[]): number {
  let anchored = 0;
  for (const row of rows) {
    if (/^(?:\*?\d+[:|]|.+?:\d+(?::\d+)?:)/u.test(row)) anchored += 1;
  }
  if (anchored > 0) return anchored;
  return rows.filter((row) => !/^#\s/u.test(row)).length;
}

function lspFailure(result: unknown): boolean {
  if (compactCardText(resultDetails(result)?.["error"], 200)) return true;
  const text = stashedOrResultText(result);
  return /(?:no language server found|language server[^\n]*failed|(?:^|\n)\s*(?:error|failed)\b)/iu.test(text);
}

function lspData(args: unknown, result: unknown): LspCardData | undefined {
  if (!isLspCardData(args, result)) return undefined;
  const fields = recordOf(args);
  const details = resultDetails(result);
  const action = isLspAction(fields?.["action"])
    ? fields["action"]
    : isLspAction(details?.["action"])
      ? details["action"]
      : undefined;
  if (!action) return undefined;
  const rows = resultRows(result);
  return {
    action,
    target: targetOf(fields),
    rows,
    itemCount: structuredCount(details) || visibleItemCount(rows),
    failure: lspFailure(result),
  };
}

function countLabel(action: LspAction): string {
  switch (action) {
    case LSP_ACTION.codeActions:
      return "actions";
    case LSP_ACTION.definition:
    case LSP_ACTION.typeDefinition:
      return "definitions";
    case LSP_ACTION.diagnostics:
      return "diagnostics";
    case LSP_ACTION.implementation:
      return "implementations";
    case LSP_ACTION.references:
      return "references";
    case LSP_ACTION.symbols:
      return "symbols";
    default:
      return "items";
  }
}

function actionHasCount(action: LspAction): boolean {
  switch (action) {
    case LSP_ACTION.codeActions:
    case LSP_ACTION.definition:
    case LSP_ACTION.diagnostics:
    case LSP_ACTION.implementation:
    case LSP_ACTION.references:
    case LSP_ACTION.symbols:
    case LSP_ACTION.typeDefinition:
      return true;
    default:
      return false;
  }
}

function summaryOf(data: LspCardData): string {
  if (data.failure) return "failed";
  if (actionHasCount(data.action)) {
    return `${data.itemCount} ${countLabel(data.action)}`;
  }
  if (data.action === LSP_ACTION.rename || data.action === LSP_ACTION.renameFile) return "renamed";
  if (data.action === LSP_ACTION.reload) return "reloaded";
  return "completed";
}

export function renderLspCardLines(
  theme: unknown,
  width: number,
  args: unknown,
  result: unknown,
  options: unknown,
  fingerprint?: string,
): readonly string[] | undefined {
  const data = lspData(args, result);
  if (!data) return undefined;
  const lifecycle = cardLifecycle(result, options, { error: data.failure });
  const base = `LSP ${data.action}${data.target ? ` ${data.target}` : ""}`;
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
          fallback: `LSP ${data.action} failed`,
          skipPattern: /^●?\s*LSP\b/iu,
        }),
        true,
      ),
    );
    return lines;
  }
  const visible = data.rows.slice(0, getPluginConfig().lspMaxItems);
  for (const row of visible) {
    const heading = /^#\s+(.+)$/u.exec(row);
    if (heading?.[1]) lines.push(cardTitleLine(theme, width, heading[1]));
    else lines.push(cardDetailLine(theme, width, row));
  }
  const hidden = data.rows.length - visible.length;
  if (hidden > 0) {
    lines.push(cardDetailLine(theme, width, `… ${hidden} more ${hidden === 1 ? "item" : "items"}`));
  }
  return lines;
}

export function renderLspCard(
  theme: unknown,
  args: unknown,
  result: unknown,
  options: unknown,
  fingerprint?: string,
): Container {
  const card = new Container();
  card.addChild({
    render: (width: number): readonly string[] =>
      renderLspCardLines(theme, width, args, result, options, fingerprint) ?? [],
  });
  markFlush?.(card);
  return card;
}

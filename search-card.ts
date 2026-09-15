// Minimal Grep and AST Grep cards. Grep execution stays delegated by index.ts;
// AST Grep stays a native tool projected by the display-only component skin.
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

export const SEARCH_CARD_KIND = {
  astGrep: "ast_grep",
  grep: "grep",
} as const;

export type SearchCardKind = (typeof SEARCH_CARD_KIND)[keyof typeof SEARCH_CARD_KIND];

interface SearchMatch {
  file: string;
  line: string;
  text: string;
}

interface SearchCardData {
  pattern: string;
  matches: readonly SearchMatch[];
  fileCounts: ReadonlyMap<string, number>;
  fileCount: number;
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

function stripSnapshotTag(value: string): string {
  return value.replace(/#[0-9A-F]{4}$/iu, "");
}

function parseMatches(text: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  let currentFile = "";
  for (const rawLine of text.split("\n")) {
    const line = compactCardText(rawLine, 1000);
    if (!line) continue;
    const header = /^#\s+(.+)$/u.exec(line);
    if (header?.[1]) {
      currentFile = stripSnapshotTag(header[1].trim());
      continue;
    }
    const anchored = /^\*?(\d+)(?::(\d+))?:(.*)$/u.exec(line);
    if (currentFile && anchored?.[1]) {
      matches.push({
        file: currentFile,
        line: anchored[2] ? `${anchored[1]}:${anchored[2]}` : anchored[1],
        text: compactCardText(anchored[3] ?? "", 500),
      });
      continue;
    }
    const colon = /^(.+?):(\d+)(?::(\d+))?:(.*)$/u.exec(line);
    if (colon?.[1] && colon[2]) {
      matches.push({
        file: stripSnapshotTag(colon[1].trim()),
        line: colon[3] ? `${colon[2]}:${colon[3]}` : colon[2],
        text: compactCardText(colon[4] ?? "", 500),
      });
    }
  }
  return matches;
}

function searchFailure(result: unknown): boolean {
  if (compactCardText(resultDetails(result)?.["error"], 200)) return true;
  const text = stashedOrResultText(result);
  return /(?:^|\n)\s*(?:error|failed|parse issue|invalid pattern)\b/iu.test(text);
}

function searchData(args: unknown, result: unknown): SearchCardData {
  const fields = recordOf(args);
  const pattern = fieldText(fields, ["pat", "pattern", "query"], 120);
  const matches = parseMatches(stashedOrResultText(result));
  const fileCounts = new Map<string, number>();
  for (const match of matches) {
    fileCounts.set(match.file, (fileCounts.get(match.file) ?? 0) + 1);
  }
  return {
    pattern,
    matches,
    fileCounts,
    fileCount: fileCounts.size,
    failure: searchFailure(result),
  };
}

/** Strict selector for the native AST Grep component skin. */
export function isAstGrepCardData(args: unknown): boolean {
  const fields = recordOf(args);
  if (!fields) return false;
  return Boolean(fieldText(fields, ["pat"], 2));
}

function cardLimit(kind: SearchCardKind): number {
  const config = getPluginConfig();
  return kind === SEARCH_CARD_KIND.grep
    ? config.grepMaxMatches
    : config.astGrepMaxMatches;
}

function cardLabel(kind: SearchCardKind): string {
  return kind === SEARCH_CARD_KIND.grep ? "Grep" : "AST Grep";
}

function resultSummary(data: SearchCardData): string {
  if (data.failure) return "failed";
  if (data.matches.length === 0) return "no matches";
  return `${data.matches.length} ${data.matches.length === 1 ? "hit" : "hits"} · ${data.fileCount} ${data.fileCount === 1 ? "file" : "files"}`;
}

export function renderSearchCardLines(
  theme: unknown,
  width: number,
  kind: SearchCardKind,
  args: unknown,
  result: unknown,
  options: unknown,
  fingerprint?: string,
): readonly string[] {
  const data = searchData(args, result);
  const lifecycle = cardLifecycle(result, options, { error: data.failure });
  const label = cardLabel(kind);
  const base = `${label}${data.pattern ? ` \`${data.pattern}\`` : ""}`;
  const body = `${base} — ${lifecycle.running ? "running" : resultSummary(data)}`;
  const lines = [
    cardHeaderLine(theme, width, {
      body,
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
          fallback: `${label} failed`,
          skipPattern: new RegExp(`^●?\\s*${label}\\b`, "iu"),
        }),
        true,
      ),
    );
    return lines;
  }
  const visible = data.matches.slice(0, cardLimit(kind));
  let currentFile = "";
  for (const match of visible) {
    if (match.file !== currentFile) {
      currentFile = match.file;
      const count = data.fileCounts.get(match.file) ?? 1;
      lines.push(
        cardTitleLine(
          theme,
          width,
          `${match.file} — ${count} ${count === 1 ? "hit" : "hits"}`,
        ),
      );
    }
    lines.push(
      cardDetailLine(
        theme,
        width,
        `${match.line}${match.text ? `: ${match.text}` : ""}`,
      ),
    );
  }
  const hidden = data.matches.length - visible.length;
  if (hidden > 0) {
    lines.push(
      cardDetailLine(
        theme,
        width,
        `… ${hidden} more ${hidden === 1 ? "match" : "matches"}`,
      ),
    );
  }
  return lines;
}

export function renderSearchCard(
  theme: unknown,
  kind: SearchCardKind,
  args: unknown,
  result: unknown,
  options: unknown,
  fingerprint?: string,
): Container {
  const card = new Container();
  card.addChild({
    render: (width: number): readonly string[] =>
      renderSearchCardLines(theme, width, kind, args, result, options, fingerprint),
  });
  markFlush?.(card);
  return card;
}

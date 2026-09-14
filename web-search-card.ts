// Minimal web-search card. Execution remains delegated by index.ts; this module
// owns only structured result reading and transcript presentation.
import { Container, visibleWidth } from "@oh-my-pi/pi-tui";
import { getPluginConfig } from "./config.ts";
import { markFlush } from "./loaders.ts";
import { isToolError, toolResultText } from "./results.ts";
import { LINE_WIDTH_RATIO, TOOL_INDENT, formatRowLine, isSettling, paintAt } from "./theme.ts";
import { searchPatternText, truncatePlain } from "./text.ts";

interface WebSearchSource {
  title: string;
  url: string;
}

interface WebSearchData {
  provider: string;
  sources: WebSearchSource[];
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function compact(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const one = value.replace(/\s+/g, " ").trim();
  if (!one) return "";
  return one.length > max ? `${one.slice(0, Math.max(1, max - 1))}…` : one;
}

function structuredSearchData(result: unknown): WebSearchData {
  const root = objectOf(result);
  const details = objectOf(root?.["details"]);
  const response = objectOf(details?.["response"]);
  const provider = compact(response?.["provider"] ?? details?.["provider"], 32);
  const rawSources = response?.["sources"];
  const sources: WebSearchSource[] = [];
  if (Array.isArray(rawSources)) {
    for (const rawSource of rawSources) {
      const source = objectOf(rawSource);
      if (!source) continue;
      const url = compact(source["url"], 240);
      if (!url) continue;
      const title = compact(source["title"], 160) || url;
      sources.push({ title, url });
    }
  }
  return { provider, sources };
}

function stashedText(result: unknown): string {
  const root = objectOf(result);
  const details = objectOf(root?.["details"]);
  const stashed = details?.["minimalFullText"];
  return typeof stashed === "string" && stashed ? stashed : toolResultText(result);
}

function fallbackSources(result: unknown): WebSearchSource[] {
  const lines = stashedText(result).split("\n");
  const sources: WebSearchSource[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const titleMatch = /^\s*\[\d+\]\s+(.+?)\s*$/.exec(lines[i] ?? "");
    if (!titleMatch?.[1]) continue;
    const url = compact(lines[i + 1]?.trim(), 240);
    if (!/^https?:\/\//i.test(url)) continue;
    sources.push({ title: compact(titleMatch[1], 160), url });
    i += 1;
  }
  return sources;
}

function nativeErrorText(result: unknown): string {
  const root = objectOf(result);
  const details = objectOf(root?.["details"]);
  return compact(details?.["error"], 120);
}

function errorText(result: unknown): string {
  const nativeError = nativeErrorText(result);
  if (nativeError) return nativeError;
  const raw = stashedText(result);
  for (const line of raw.split("\n")) {
    const one = compact(line.replace(/^\s*(?:error|failed?)\s*:?\s*/i, ""), 120);
    if (one && !/^●?\s*Search\b/i.test(one)) return one;
  }
  return "Search request failed";
}

function detailLine(theme: unknown, width: number, text: string): string {
  const cfg = getPluginConfig();
  const prefix = `${TOOL_INDENT}   `;
  const rowWidth = Math.max(1, Math.floor((Math.floor(width) || 0) * LINE_WIDTH_RATIO));
  const budget = Math.max(1, rowWidth - visibleWidth(prefix));
  return `${prefix}${paintAt(theme, truncatePlain(text, budget), "dim", cfg.opacity)}`;
}

export function renderWebSearchCard(
  theme: unknown,
  args: unknown,
  result: unknown,
  options: unknown,
  fp?: string,
): Container {
  try {
    const partial = result !== undefined && (options as { isPartial?: boolean } | null | undefined)?.isPartial === true;
    const running = result === undefined || partial;
    const error = !running && (nativeErrorText(result) !== "" || isToolError(result, options));
    const expanded = (options as { expanded?: boolean } | null | undefined)?.expanded === true;
    const query = compact(searchPatternText(args), 80);
    const data = structuredSearchData(result);
    const sources = data.sources.length > 0 ? data.sources : fallbackSources(result);
    const base = `Search${query ? ` \`${query}\`` : ""}`;
    const count = sources.length;
    const body = running
      ? base
      : error
        ? `${base} — failed`
        : `${base} — ${count} ${count === 1 ? "source" : "sources"}`;
    const right = data.provider ? `via ${data.provider}` : "";
    const c = new Container();
    c.addChild({
      render: (width: number): readonly string[] => {
        try {
          const spinning = running || (fp !== undefined && isSettling(fp));
          const lines: string[] = [
            formatRowLine(theme, width, {
              body,
              live: running,
              error,
              right,
              fadeKey: fp,
              mark: spinning ? undefined : "●",
            }),
          ];
          if (!expanded || running) return lines;
          if (error) {
            lines.push(
              formatRowLine(theme, width, {
                body: errorText(result),
                indent: true,
                tree: "last",
                error: true,
              }),
            );
            return lines;
          }
          const maxResults = getPluginConfig().webSearchMaxResults;
          const visible = sources.slice(0, maxResults);
          for (const source of visible) {
            lines.push(
              formatRowLine(theme, width, {
                body: source.title,
                indent: true,
                tree: "last",
              }),
            );
            lines.push(detailLine(theme, width, source.url));
          }
          const hidden = sources.length - visible.length;
          if (hidden > 0)
            lines.push(detailLine(theme, width, `╰─ … ${hidden} more ${hidden === 1 ? "source" : "sources"}`));
          return lines;
        } catch {
          return [formatRowLine(theme, width, { body: base, live: running, error, mark: running ? undefined : "●" })];
        }
      },
    });
    markFlush?.(c);
    return c;
  } catch {
    const c = new Container();
    c.addChild({
      render: (width: number): readonly string[] => [
        formatRowLine(theme, width, { body: "Search", error: true, mark: "●" }),
      ],
    });
    markFlush?.(c);
    return c;
  }
}

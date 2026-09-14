// Minimal web-search card. Execution remains delegated by index.ts; this module
// owns only structured result reading and transcript presentation.
import { Container } from "@oh-my-pi/pi-tui";
import { getPluginConfig } from "./config.ts";
import {
  cardDetailLine,
  cardHeaderLine,
  cardLifecycle,
  cardTitleLine,
  compactCardText,
  conciseErrorText,
  limitCardItems,
  resultDetails,
  stashedOrResultText,
} from "./card-primitives.ts";
import { markFlush } from "./loaders.ts";
import { searchPatternText } from "./text.ts";

interface WebSearchSource {
  title: string;
  url: string;
}

interface WebSearchData {
  provider: string;
  sources: WebSearchSource[];
}

function structuredSearchData(result: unknown): WebSearchData {
  const details = resultDetails(result);
  const responseValue = details?.["response"];
  let response: Record<string, unknown> | undefined;
  if (typeof responseValue === "object" && responseValue !== null && !Array.isArray(responseValue)) {
    response = responseValue as Record<string, unknown>;
  }
  const provider = compactCardText(response?.["provider"] ?? details?.["provider"], 32);
  const rawSources = response?.["sources"];
  const sources: WebSearchSource[] = [];
  if (Array.isArray(rawSources)) {
    for (const rawSource of rawSources) {
      if (typeof rawSource !== "object" || rawSource === null || Array.isArray(rawSource)) continue;
      const source = rawSource as Record<string, unknown>;
      const url = compactCardText(source["url"], 240);
      if (!url) continue;
      const title = compactCardText(source["title"], 160) || url;
      sources.push({ title, url });
    }
  }
  return { provider, sources };
}

function fallbackSources(result: unknown): WebSearchSource[] {
  const lines = stashedOrResultText(result).split("\n");
  const sources: WebSearchSource[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const titleMatch = /^\s*\[\d+\]\s+(.+?)\s*$/.exec(lines[i] ?? "");
    if (!titleMatch?.[1]) continue;
    const url = compactCardText(lines[i + 1]?.trim(), 240);
    if (!/^https?:\/\//i.test(url)) continue;
    sources.push({ title: compactCardText(titleMatch[1], 160), url });
    i += 1;
  }
  return sources;
}

export function renderWebSearchCard(
  theme: unknown,
  args: unknown,
  result: unknown,
  options: unknown,
  fp?: string,
): Container {
  try {
    const nativeError = compactCardText(resultDetails(result)?.["error"], 120);
    const lifecycle = cardLifecycle(result, options, { error: nativeError !== "" });
    const { expanded, running, error } = lifecycle;
    const query = compactCardText(searchPatternText(args), 80);
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
          const lines: string[] = [
            cardHeaderLine(theme, width, {
              body,
              lifecycle,
              right,
              fingerprint: fp,
              settledMark: "●",
            }),
          ];
          if (!expanded || running) return lines;
          if (error) {
            lines.push(
              cardTitleLine(
                theme,
                width,
                conciseErrorText(result, {
                  fallback: "Search request failed",
                  skipPattern: /^●?\s*Search\b/i,
                }),
                true,
              ),
            );
            return lines;
          }
          const limited = limitCardItems(sources, getPluginConfig().webSearchMaxResults);
          for (const source of limited.visible) {
            lines.push(cardTitleLine(theme, width, source.title));
            lines.push(cardDetailLine(theme, width, source.url));
          }
          if (limited.hidden > 0) {
            lines.push(
              cardDetailLine(
                theme,
                width,
                `╰─ … ${limited.hidden} more ${limited.hidden === 1 ? "source" : "sources"}`,
              ),
            );
          }
          return lines;
        } catch {
          return [cardHeaderLine(theme, width, { body, lifecycle, settledMark: "●" })];
        }
      },
    });
    markFlush?.(c);
    return c;
  } catch {
    const errorLifecycle = cardLifecycle({ isError: true }, undefined);
    const c = new Container();
    c.addChild({
      render: (width: number): readonly string[] => [
        cardHeaderLine(theme, width, { body: "Search", lifecycle: errorLifecycle, settledMark: "●" }),
      ],
    });
    markFlush?.(c);
    return c;
  }
}
